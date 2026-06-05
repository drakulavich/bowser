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
import { openBrowser, assertValidBackendEnv, type Browser } from "./browser.ts";
import { createSerializer, withTimeout } from "./serialize.ts";

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
  return join(process.env.HOME || homedir(), ".bowser", "sessions", session, "sock");
}

/** Per-operation timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
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
          // Browser returns base64 PNG; the CLI writes the file (so a relative
          // --filename resolves against the user's cwd, not the daemon's).
          const r = await browser.screenshot();
          return { id: req.id, ok: true, result: r };
        }
        case "back":    await browser.back();    return { id: req.id, ok: true };
        case "forward": await browser.forward(); return { id: req.id, ok: true };
        case "reload":  await browser.reload();  return { id: req.id, ok: true };
        case "state":
          return {
            id: req.id,
            ok: true,
            result: { url: await browser.realUrl(), title: browser.title },
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

  const serialize = createSerializer();
  const timeoutMs = opTimeoutMs();

  Bun.listen({
    unix: sock,
    socket: {
      data(socket, data) {
        // Requests are newline-delimited. Accumulate partial data on
        // socket.data and process complete lines.
        const existing = ((socket as { data?: string }).data ?? "") + data.toString();
        const lines = existing.split("\n");
        const remainder = lines.pop() ?? "";
        (socket as { data?: string }).data = remainder;
        for (const line of lines) {
          if (!line) continue;
          let req: DaemonRequest;
          try {
            req = JSON.parse(line) as DaemonRequest;
          } catch (err) {
            socket.write(
              JSON.stringify({
                id: -1,
                ok: false,
                error: "invalid JSON: " + String(err),
              }) + "\n",
            );
            continue;
          }
          // Serialize on the UNDERLYING op (not the timeout): the WebView lock is
          // held until handle(req) actually settles, so a timed-out-but-still-
          // running op can never overlap the next one. withTimeout only governs
          // how soon we answer the client. (A genuinely wedged op therefore holds
          // the queue until it drains — an unrecoverable WebView is killed via
          // `close`/process exit, not by overlapping a new op onto it.)
          serialize(() => {
            const underlying = handle(req);
            withTimeout(underlying, timeoutMs, req.op).then(
              (res) => {
                socket.write(JSON.stringify(res) + "\n");
              },
              (err) => {
                // handle() catches its own errors; this path is for timeouts.
                const msg = err instanceof Error ? err.message : String(err);
                socket.write(JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
              },
            );
            return underlying;
          }).catch(() => {
            // handle() never rejects; this guards against an unhandled rejection
            // if that ever changes. The client response is written above.
          });
        }
      },
      open(socket) {
        (socket as { data?: string }).data = "";
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
    // @ts-expect-error Bun.connect unix option
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
    // Validate backend config in the parent before spawning: the daemon opens
    // the browser (and would throw on a bad BOWSER_BACKEND) before it ever opens
    // its socket, so that error is invisible to us and shows up only as the
    // "did not start in time" timeout below. Fail fast with the real message.
    assertValidBackendEnv();
    // Spawn a detached daemon process.
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
  const { ensureSessionDir, sessionDir } = await import("./state.ts");
  await ensureSessionDir(session);
  const entry = new URL("./daemon-main.ts", import.meta.url).pathname;

  // When BOWSER_CHROME_DEBUG is set, capture daemon + Chrome stderr to a log
  // file inside the session dir so spawn failures are diagnosable.
  const debug = process.env.BOWSER_CHROME_DEBUG === "1";
  let stdout: "ignore" | "inherit" = "ignore";
  let stderr: "ignore" | "inherit" = "ignore";
  if (debug) {
    stdout = "inherit";
    stderr = "inherit";
    void sessionDir;
  }

  Bun.spawn({
    cmd: [process.execPath, entry, session],
    stdout,
    stderr,
    stdin: "ignore",
    // Detach so the daemon survives the parent CLI exiting.
    // Bun inherits no ptty by default; this is effectively fire-and-forget.
  });
}
