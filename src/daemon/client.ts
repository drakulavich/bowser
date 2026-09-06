// Client side of the daemon protocol: connect to a session's Unix socket (or
// spawn the daemon first), send typed requests, match replies by id.

import { join } from "node:path";
import { flushSocket, socketWriteAll, type WritableSocket } from "../socket-write.ts";
import { sessionsRoot } from "../state.ts";
import { assertValidBackendEnv } from "../browser.ts";
import type { DaemonConnection, DaemonResponse, Op, RequestParams, ResultOf } from "./protocol.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(sessionsRoot(), session, "sock");
}

export class DaemonClient implements DaemonConnection {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  private nextId = 1;
  private pending = new Map<number, (res: DaemonResponse) => void>();
  private buf = "";

  constructor(private readonly path: string) {}

  async connect(): Promise<void> {
    const self = this;
    this.sock = await Bun.connect({
      unix: this.path,
      socket: {
        data(_s, data) {
          self.buf += data.toString();
          let idx: number;
          while ((idx = self.buf.indexOf("\n")) !== -1) {
            const line = self.buf.slice(0, idx);
            self.buf = self.buf.slice(idx + 1);
            if (!line) continue;
            try {
              const res = JSON.parse(line) as DaemonResponse;
              const cb = self.pending.get(res.id);
              if (cb) {
                self.pending.delete(res.id);
                cb(res);
              }
            } catch {
              // swallow
            }
          }
        },
        drain(s) {
          flushSocket(s as unknown as WritableSocket);
        },
      },
    });
  }

  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>> {
    const [op, args = []] = params;
    if (!this.sock) throw new Error("client not connected");
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.ok) resolve(res.result as ResultOf<O>);
        else reject(new Error(res.error ?? "daemon error"));
      });
      socketWriteAll(this.sock! as unknown as WritableSocket, line);
    });
  }

  close(): void {
    this.sock?.end();
  }
}

/** Connect to a session's daemon, or spawn one if it isn't running. */
export async function connectOrSpawn(
  session: string,
  opts: { spawn?: boolean } = {},
): Promise<DaemonClient> {
  const sock = socketPath(session);
  const client = new DaemonClient(sock);
  try {
    await client.connect();
    await client.request("ping");
    return client;
  } catch {
    if (opts.spawn === false) throw new Error(`no daemon for session '${session}'`);
    // Validate backend config in the parent before spawning: the daemon opens
    // the browser (and would throw on a bad BOWSER_BACKEND) before it ever opens
    // its socket, so that error is invisible to us and shows up only as the
    // "did not start in time" timeout below. Fail fast with the real message.
    assertValidBackendEnv();
    await spawnDaemon(session);
    // Poll until the socket is listening.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        const c = new DaemonClient(sock);
        await c.connect();
        await c.request("ping");
        return c;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new Error(`daemon for session '${session}' did not start in time`);
  }
}

async function spawnDaemon(session: string): Promise<void> {
  const { ensureSessionDir } = await import("../state.ts");
  await ensureSessionDir(session);

  // When running as a compiled single-file binary, import.meta.url points to
  // a virtual /$bunfs/root/ path that Bun.spawn cannot execute. In that case
  // re-invoke the binary itself with a hidden --daemon flag; cli.ts intercepts
  // it before the normal command dispatcher and starts the daemon directly.
  // Use includes(), not startsWith(): Bun reports this module's import.meta.url
  // as "file:///$bunfs/root/..." (with a file:// scheme), so a startsWith check
  // misses it and silently falls through to the broken, unspawnable path.
  const isCompiled = import.meta.url.includes("/$bunfs/");
  const cmd: string[] = isCompiled
    ? [process.execPath, "--daemon", session]
    : [process.execPath, new URL("./main.ts", import.meta.url).pathname, session];

  // When BOWSER_CHROME_DEBUG is set, let the daemon's stdio through so spawn
  // failures are diagnosable.
  const debug = process.env.BOWSER_CHROME_DEBUG === "1";
  const stdio: "ignore" | "inherit" = debug ? "inherit" : "ignore";

  const proc = Bun.spawn({
    cmd,
    stdout: stdio,
    stderr: stdio,
    stdin: "ignore",
    // Pass the LIVE process.env. Without an explicit `env`, Bun.spawn inherits
    // the OS environment block captured at *this* process's startup and ignores
    // runtime mutations of process.env — so a redirected HOME (set after launch,
    // e.g. by the e2e tests' beforeAll) would NOT reach the daemon.
    env: { ...process.env },
  });
  // Don't let the spawned daemon keep THIS process alive. Bun keeps the parent's
  // event loop open until a child exits — but the daemon runs forever (keepalive
  // interval), so without unref() a daemon-spawning command (e.g. `bowser open`
  // on a fresh session) prints its result and then hangs indefinitely instead of
  // returning to the shell. `bun test` masks this (the test runner force-exits);
  // the real binary does not. unref() lets the short-lived CLI exit immediately.
  proc.unref();
}
