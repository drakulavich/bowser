// Client side of the daemon protocol: connect to a session's Unix socket (or
// spawn the daemon first), send typed requests, match replies by id.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import { withTimeout } from "../serialize.ts";
import { flushSocket, socketWriteAll, type WritableSocket } from "../socket-write.ts";
import { sessionDir, statePath } from "../state.ts";
import type { DaemonConnection, DaemonResponse, DialogReport, Op, RequestParams, ResultOf } from "./protocol.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  // sessionDir() is what validates the name; going through it is what keeps a
  // traversing session name out of every path bowser builds.
  return join(sessionDir(session), "sock");
}

/** Where the daemon records its own pid, beside its socket. `close` needs it
 *  to confirm the process actually died: an unreachable daemon has no socket
 *  to ask, so without this the only honest answer is "something may still be
 *  running". */
export function pidPath(session: string): string {
  return join(sessionDir(session), "pid");
}

export class DaemonClient implements DaemonConnection {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  private buf = "";
  private closed = false;
  private reported: DialogReport[] = [];
  private report = false;

  constructor(
    private readonly path: string,
    private readonly session: string,
  ) {}

  private get closedMessage(): string {
    return `daemon for session '${this.session}' closed the connection`;
  }

  /** The socket is gone, whoever closed it: nothing pending will ever get a
   *  reply, so fail it all now instead of leaving the caller hanging. */
  private markClosed(message = this.closedMessage): void {
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(new Error(message));
  }

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
              const entry = self.pending.get(res.id);
              if (entry) {
                if (res.dialogs) self.reported.push(...res.dialogs);
                self.pending.delete(res.id);
                if (res.ok) entry.resolve(res.result);
                else entry.reject(new Error(res.error ?? "daemon error"));
              }
            } catch {
              // swallow
            }
          }
        },
        drain(s) {
          flushSocket(s as unknown as WritableSocket);
        },
        end() {
          self.markClosed();
        },
        close() {
          self.markClosed();
        },
        error(_s, err) {
          self.markClosed(`${self.closedMessage}: ${err.message}`);
        },
      },
    });
  }

  dialogs(): DialogReport[] {
    return [...this.reported];
  }

  reportDialogs(): void {
    this.report = true;
  }

  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>> {
    const [op, args = []] = params;
    if (!this.sock) throw new Error("client not connected");
    if (this.closed) return Promise.reject(new Error(this.closedMessage));
    const id = this.nextId++;
    const line = JSON.stringify(this.report ? { id, op, args, report: true } : { id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as ResultOf<O>), reject });
      socketWriteAll(this.sock! as unknown as WritableSocket, line);
    });
  }

  close(): void {
    this.sock?.end();
    this.markClosed();
  }
}

/** How long a daemon has to answer the health check before it counts as
 *  unreachable. It answers in microseconds when it is alive at all: `ping` is
 *  on the daemon's urgent lane, so even a busy one replies immediately. */
const HEALTH_PING_MS = 1000;

/** How a command reaches its daemon. `spawn: false` refuses to start one;
 *  `profile` is the persistent store a daemon spawned now opens with (a
 *  running daemon keeps the store it started with). */
export interface ConnectOptions {
  spawn?: boolean;
  profile?: string;
  /** The platform a daemon would run on; `process.platform` unless a test
   *  fakes it. */
  platform?: string;
  /** The Bun a daemon would run on; the running one unless a test fakes it. */
  runtime?: BunRuntime;
  /** Start a daemon even where one ran and exited. Only `open` sets it: every
   *  other command refuses such a session (F28). */
  reopen?: boolean;
}

/** Why a command refuses a session whose daemon ran and is gone: its page,
 *  refs and, for `--persistent`, its store went with it, and a new daemon
 *  started quietly would be an empty in-memory browser. A user error (exit 1). */
export function browserExited(session: string): string {
  return `session '${session}' is not open (its browser exited); run 'bowser open'`;
}

/** Why bowser cannot start a daemon off macOS: its only engine is WebKit's
 *  Bun.WebView, which throws on other platforms. A user error (exit 1). */
export const REQUIRES_MACOS = "bowser requires macOS (WebKit)";

/** What the Bun guard looks at in the running Bun. */
export interface BunRuntime {
  version: string;
  webView: boolean;
}

/** Why bowser refuses a Bun below `engines.bun`, or one without Bun.WebView:
 *  npm does not enforce `engines.bun`, and on such a Bun the daemon would die
 *  unseen. A user error (exit 1). The floor is read from package.json, so the
 *  message follows it. */
export function unsupportedBun(runtime: BunRuntime): string | undefined {
  const floor = pkg.engines.bun;
  if (runtime.webView && Bun.semver.satisfies(runtime.version, floor)) return undefined;
  return `bowser requires Bun ${floor} (found ${runtime.version})`;
}

/** The environment variable that carries the profile to a spawned daemon.
 *  Env rather than argv: `looksLikeOurDaemon` identifies a daemon by its last
 *  two argv words. */
export const DAEMON_PROFILE_ENV = "BOWSER_DAEMON_PROFILE";

/** Connect to a session's daemon, or spawn one if it isn't running. */
export async function connectOrSpawn(
  session: string,
  opts: ConnectOptions = {},
): Promise<DaemonClient> {
  const sock = socketPath(session);
  const client = new DaemonClient(sock, session);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    // Bound the health check. A daemon that accepts the connection and never
    // answers — stopped, or blocked in a syscall — would otherwise hang every
    // caller forever, `list` included. Treating it as unreachable is what the
    // callers already know how to handle.
    await withTimeout(client.request("ping"), HEALTH_PING_MS, "ping");
    return client;
  } catch {
    // Close before falling through: a connected socket that is never closed
    // keeps the process alive after the command has printed its answer.
    client.close();
    if (opts.spawn === false) throw new Error(`no daemon for session '${session}'`);
    // Do not replace a daemon whose socket accepted our connection but whose
    // health check timed out. Unlinking its socket and spawning another daemon
    // would leave two browser processes for one session, while the old one
    // would no longer be addressable by its pidfile.
    if (connected) {
      throw new Error(`daemon for session '${session}' did not answer; run 'bowser close -s ${session}' to stop it`);
    }
    // A daemon ran here (it left state.json) and none answers now: its
    // browser exited. Only `open` may start another; `close` never spawns.
    // A fresh session has no state.json and still spawns lazily.
    if (!opts.reopen && (await Bun.file(statePath(session)).exists())) throw new Error(browserExited(session));
    // The one platform check. The daemon opens its WebView before it opens its
    // socket, so off macOS it would die unseen, and the caller would get only
    // the "did not start in time" timeout below. Refuse with the real reason.
    if ((opts.platform ?? process.platform) !== "darwin") throw new Error(REQUIRES_MACOS);
    // The Bun guard, for the same reason: the daemon would die unseen.
    const bunError = unsupportedBun(opts.runtime ?? { version: Bun.version, webView: typeof Bun.WebView === "function" });
    if (bunError) throw new Error(bunError);
    await spawnDaemon(session, opts.profile);
    // Poll until the socket is listening.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = new DaemonClient(sock, session);
      try {
        await c.connect();
        await withTimeout(c.request("ping"), HEALTH_PING_MS, "ping");
        return c;
      } catch {
        c.close();
        await Bun.sleep(50);
      }
    }
    // A daemon that dies opening its browser never reaches its socket, so its
    // error is invisible here. A persistent store is the likely cause when one
    // was asked for (WebKit needs macOS 15.2+ for it), so say so.
    const hint = opts.profile
      ? ` with --persistent profile ${opts.profile}; the browser may not support a persistent profile here`
      : "";
    throw new Error(`daemon for session '${session}' did not start in time${hint}`);
  }
}

async function spawnDaemon(session: string, profile?: string): Promise<void> {
  const { ensureSessionDir } = await import("../state.ts");
  await ensureSessionDir(session);
  // Create the profile here, in the CLI, and only for a daemon about to be
  // spawned: no daemon runs, so there is no store conflict to refuse and
  // nothing is left behind by a refused open. A failure (permissions, a file
  // in the way) is reported now, with its cause; inside the daemon it would
  // only show up as a startup timeout.
  if (profile) {
    try {
      await mkdir(profile, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot create profile directory ${profile}: ${msg}`);
    }
  }

  // Always `bun <package>/src/daemon/main.ts <session>`: from a checkout and
  // from an npm install alike, main.ts sits beside this file.
  const cmd = [process.execPath, new URL("./main.ts", import.meta.url).pathname, session];

  // When BOWSER_DAEMON_DEBUG is set, let the daemon's stdio through so spawn
  // failures are diagnosable.
  const debug = process.env.BOWSER_DAEMON_DEBUG === "1";
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
    env: daemonEnv(profile),
  });
  // Don't let the spawned daemon keep THIS process alive. Bun keeps the parent's
  // event loop open until a child exits — but the daemon runs forever (keepalive
  // interval), so without unref() a daemon-spawning command (e.g. `bowser open`
  // on a fresh session) prints its result and then hangs indefinitely instead of
  // returning to the shell. Measured from source: without it, `bun src/cli.ts
  // open <url>` printed `opened …` and hung until killed. `bun test` masks this
  // (the runner force-exits); tests/e2e-spawn-exit.test.ts runs the CLI as its
  // own process and fails without it.
  proc.unref();
}

/** The daemon's environment: ours, with the profile set or cleared so a stale
 *  value inherited from the caller never picks the store. */
function daemonEnv(profile: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (profile) env[DAEMON_PROFILE_ENV] = profile;
  else delete env[DAEMON_PROFILE_ENV];
  return env;
}
