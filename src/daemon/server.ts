// Per-session daemon. A long-lived Bun process holds one Bun.WebView and
// services client commands over a Unix socket. This is what gives Bowser
// real stateful multi-step flows — a fresh browser per command would lose
// everything the page accumulated (typed text, modals, dynamic DOM).
//
// The op set lives in ./protocol.ts. `handlers` below is typed from it, so
// an op without a handler here does not compile.

import { unlink } from "node:fs/promises";
import { CDP_UNAVAILABLE, openBrowser, type Browser } from "../browser.ts";
import { createSerializer, withTimeout } from "../serialize.ts";
import { socketWriteAll, flushSocket, type WritableSocket } from "../socket-write.ts";
import { REQUIRES_CDP, type ArgsOf, type DaemonRequest, type DaemonResponse, type Op, type ResultOf } from "./protocol.ts";
import { socketPath } from "./client.ts";

/** Per-operation timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

type Handlers = {
  [O in Op]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
};

const handlers: Handlers = {
  ping: async () => "pong",
  shutdown: async (browser) => {
    // Respond first, then exit: the caller gets its { ok: true } before the
    // process goes away. A macrotask, not a microtask: the reply is written
    // from a promise continuation, and a queued microtask exit ran before it
    // once Browser.close() stopped awaiting anything (PR 3).
    setTimeout(async () => {
      try {
        await browser.close();
      } catch {}
      process.exit(0);
    }, 0);
  },
  state: async (browser) => ({ url: await browser.realUrl(), title: await browser.realTitle() }),
  navigate: (browser, url) => browser.navigate(url),
  evaluate: (browser, expr) => browser.evaluate(expr),
  click: (browser, selector) => browser.click(selector),
  type: (browser, text) => browser.type(text),
  press: (browser, key) => browser.press(key),
  hover: (browser, selector) => browser.hover(selector),
  select: (browser, selector, value) => browser.select(selector, value),
  check: (browser, selector) => browser.setChecked(selector, true),
  uncheck: (browser, selector) => browser.setChecked(selector, false),
  screenshot: async (browser, path) => {
    // When the CLI passes an absolute path, the daemon writes the PNG itself
    // so the ~140 KB base64 never crosses the socket. With no path, return
    // base64 — reserved for a future --stdout / programmatic caller.
    const b64 = await browser.screenshot();
    if (path) {
      await Bun.write(path, Buffer.from(b64, "base64"));
      return { path };
    }
    return b64;
  },
  resize: (browser, width, height) => browser.resize(width, height),
  back: (browser) => browser.back(),
  forward: (browser) => browser.forward(),
  reload: (browser) => browser.reload(),
  // --- Cookie ops (chrome only; the Browser rejects them on webkit) ---
  "cookie-get-all": (browser, urls) => browser.getCookies(urls),
  "cookie-set": (browser, param) => browser.setCookie(param),
  "cookie-delete": (browser, name, opts) => browser.deleteCookies(name, opts),
  "cookie-clear": (browser) => browser.clearCookies(),
};

/** Dispatch one parsed request to its handler. Never rejects: every failure,
 *  including an op name that is not in the map, is a `{ ok: false }` reply. */
export function createHandler(browser: Browser): (req: DaemonRequest) => Promise<DaemonResponse> {
  return async (req) => {
    const fn = Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
    if (!fn) return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
    // Capability gate: a CDP-only op on webkit fails here with the shared
    // message, so the handler never touches a view that cannot answer.
    if (REQUIRES_CDP.has(req.op) && !browser.cdpAvailable()) {
      return { id: req.id, ok: false, error: CDP_UNAVAILABLE };
    }
    try {
      // The one cast at the wire boundary: args arrived as JSON, the handler
      // is typed for this op. Everything below this line is typed.
      const result = await (fn as (b: Browser, ...a: unknown[]) => Promise<unknown>)(browser, ...(req.args ?? []));
      return result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: req.id, ok: false, error: msg };
    }
  };
}

export async function startDaemon(session: string): Promise<void> {
  const sock = socketPath(session);
  // Clean up any stale socket file.
  try {
    await unlink(sock);
  } catch {}

  const browser: Browser = await openBrowser();
  const handle = createHandler(browser);
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
            socketWriteAll(
              socket as unknown as WritableSocket,
              JSON.stringify({ id: -1, ok: false, error: "invalid JSON: " + String(err) }) + "\n",
            );
            continue;
          }
          // Serialize on the UNDERLYING op (not the timeout): the WebView lock is
          // held until handle(req) actually settles, so a timed-out-but-still-
          // running op can never overlap the next one. withTimeout only governs
          // how soon we answer the client.
          if (req.op === "shutdown") {
            // Shutdown must NOT queue behind a wedged op — its job is to kill a
            // possibly-stuck daemon. Dispatch it directly, bypassing the serializer.
            handle(req).then((res) => {
              socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
            }).catch(() => {
              // handle() never rejects; mirrors the guard on the serialized path.
            });
          } else {
            serialize(() => {
              const underlying = handle(req);
              withTimeout(underlying, timeoutMs, req.op).then(
                (res) => {
                  socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
                },
                (err) => {
                  // handle() catches its own errors; this path is for timeouts.
                  const msg = err instanceof Error ? err.message : String(err);
                  socketWriteAll(socket as unknown as WritableSocket, JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
                },
              );
              return underlying;
            }).catch(() => {
              // handle() never rejects; guards against an unhandled rejection.
            });
          }
        }
      },
      open(socket) {
        (socket as { data?: string }).data = "";
      },
      drain(socket) {
        flushSocket(socket as unknown as WritableSocket);
      },
      error(socket, err) {
        console.error("[bowser daemon] socket error:", err.message);
        // Close the socket so its WriteQueue (`_wq` in socket-write.ts) can't
        // strand buffered chunks on a peer that will never fire `drain` again.
        socket.end();
      },
    },
  });

  // Keep the process alive. Bun.WebView doesn't hold the loop open on its own.
  const keepalive = setInterval(() => {}, 60_000);
  // Clean up if the event loop does settle.
  process.on("beforeExit", () => clearInterval(keepalive));
}
