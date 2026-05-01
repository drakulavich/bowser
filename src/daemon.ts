// Per-session daemon. A long-lived Bun process holds one Bun.WebView and
// services client commands over a Unix socket. This is what gives Bowser
// real stateful multi-step flows — a fresh browser per command would lose
// everything the page accumulated (typed text, modals, dynamic DOM).
//
// Wire protocol: newline-delimited JSON. Each message is either a request
//   { id, op, args }
// or a response
//   { id, ok: true, result } | { id, ok: false, error }
//
// Ops mirror the Browser interface in browser.ts.

import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openBrowser, type Browser } from "./browser.ts";

export interface DaemonRequest {
  id: number;
  op:
    | "navigate"
    | "evaluate"
    | "click"
    | "type"
    | "press"
    | "hover"
    | "select"
    | "check"
    | "uncheck"
    | "screenshot"
    | "back"
    | "forward"
    | "reload"
    | "state"
    | "ping"
    | "shutdown";
  args?: unknown[];
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(homedir(), ".bowser", "sessions", session, "sock");
}

/** Consume newline-delimited frames from a buffer, calling onLine for each
 *  complete line. Returns the unconsumed remainder. */
function consumeLines(buf: string, onLine: (line: string) => void): string {
  let s = buf;
  let idx: number;
  while ((idx = s.indexOf("\n")) !== -1) {
    const line = s.slice(0, idx);
    s = s.slice(idx + 1);
    if (line) onLine(line);
  }
  return s;
}

export async function startDaemon(session: string): Promise<void> {
  const sock = socketPath(session);
  // Clean up any stale socket file.
  try {
    await unlink(sock);
  } catch {}

  const browser: Browser = await openBrowser();

  async function handle(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const args = (req.args ?? []) as unknown[];
      switch (req.op) {
        case "ping":
          return { id: req.id, ok: true, result: "pong" };
        case "navigate":
          await browser.navigate(args[0] as string);
          return { id: req.id, ok: true };
        case "evaluate": {
          const r = await browser.evaluate(args[0] as string);
          return { id: req.id, ok: true, result: r };
        }
        case "click":
          await browser.click(args[0] as string);
          return { id: req.id, ok: true };
        case "type":
          await browser.type(args[0] as string);
          return { id: req.id, ok: true };
        case "press":
          await browser.press(args[0] as string);
          return { id: req.id, ok: true };
        case "hover":
          await browser.hover(args[0] as string);
          return { id: req.id, ok: true };
        case "select":
          await browser.select(args[0] as string, args[1] as string);
          return { id: req.id, ok: true };
        case "check":
          await browser.setChecked(args[0] as string, true);
          return { id: req.id, ok: true };
        case "uncheck":
          await browser.setChecked(args[0] as string, false);
          return { id: req.id, ok: true };
        case "screenshot": {
          const r = await browser.screenshot({
            selector: args[0] as string | undefined,
            path: args[1] as string | undefined,
          });
          return { id: req.id, ok: true, result: r };
        }
        case "back":    await browser.back();    return { id: req.id, ok: true };
        case "forward": await browser.forward(); return { id: req.id, ok: true };
        case "reload":  await browser.reload();  return { id: req.id, ok: true };
        case "state":
          return {
            id: req.id,
            ok: true,
            result: { url: browser.url, title: browser.title },
          };
        case "shutdown":
          // Respond first, then exit.
          queueMicrotask(async () => {
            try {
              await browser.close();
            } catch {}
            process.exit(0);
          });
          return { id: req.id, ok: true };
        default:
          return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: req.id, ok: false, error: msg };
    }
  }

  const buffers = new WeakMap<object, string>();
  Bun.listen({
    unix: sock,
    socket: {
      data(socket, data) {
        const next = consumeLines((buffers.get(socket) ?? "") + data.toString(), (line) => {
          let req: DaemonRequest;
          try {
            req = JSON.parse(line) as DaemonRequest;
          } catch (err) {
            socket.write(JSON.stringify({ id: -1, ok: false, error: "invalid JSON: " + String(err) }) + "\n");
            return;
          }
          handle(req).then((res) => socket.write(JSON.stringify(res) + "\n"));
        });
        buffers.set(socket, next);
      },
      error(_socket, err) {
        console.error("[bowser daemon] socket error:", err.message);
      },
    },
  });

  // Keep the process alive. Bun.WebView doesn't hold the loop open on its own.
  const keepalive = setInterval(() => {}, 60_000);
  // Clean up if the event loop does settle.
  process.on("beforeExit", () => clearInterval(keepalive));
}

export class DaemonClient {
  private sock: ReturnType<typeof Bun.connect> | undefined;
  private nextId = 1;
  private pending = new Map<number, (res: DaemonResponse) => void>();
  private buf = "";

  constructor(private readonly path: string) {}

  async connect(): Promise<void> {
    const self = this;
    const rejectPending = (msg: string) => {
      for (const [id, cb] of self.pending) cb({ id, ok: false, error: msg });
      self.pending.clear();
    };
    // @ts-expect-error Bun.connect unix option
    this.sock = await Bun.connect({
      unix: this.path,
      socket: {
        data(_s, data) {
          self.buf = consumeLines(self.buf + data.toString(), (line) => {
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
          });
        },
        close: () => rejectPending("daemon disconnected"),
        error: (_s, err) => rejectPending(err.message),
      },
    });
  }

  request(op: DaemonRequest["op"], args: unknown[] = []): Promise<unknown> {
    if (!this.sock) throw new Error("client not connected");
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.ok) resolve(res.result);
        else reject(new Error(res.error ?? "daemon error"));
      });
      this.sock!.write(line);
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
    // Spawn a detached daemon process.
    await spawnDaemon(session);
    // Poll until the socket is listening.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = new DaemonClient(sock);
      try {
        await c.connect();
        await c.request("ping");
        return c;
      } catch {
        c.close();
        await Bun.sleep(50);
      }
    }
    throw new Error(`daemon for session '${session}' did not start in time`);
  }
}

async function spawnDaemon(session: string): Promise<void> {
  const { ensureSessionDir } = await import("./state.ts");
  await ensureSessionDir(session);
  const entry = new URL("./daemon-main.ts", import.meta.url).pathname;
  const debug = process.env.BOWSER_CHROME_DEBUG === "1";
  const io = debug ? "inherit" : "ignore";

  Bun.spawn({
    cmd: [process.execPath, entry, session],
    stdout: io,
    stderr: io,
    stdin: "ignore",
    // Detach so the daemon survives the parent CLI exiting.
  });
}
