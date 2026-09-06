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
import { IS_URGENT, REQUIRES_CDP, type ArgsOf, type DaemonRequest, type DaemonResponse, type DialogState, type Op, type PageState, type ResultOf } from "./protocol.ts";
import { socketPath } from "./client.ts";

/** What the daemon knows that the page cannot be asked for. `url` and `title`
 *  are deliberately NOT here: they are read live from the page on every
 *  `state` call, because an action can navigate and a cached copy would go
 *  stale (that regression is why `nav.act()` exists). */
export interface DaemonState {
  dialog?: DialogState;
}

/** What `dispatch` needs from the daemon. Separated from the socket so the
 *  lane choice can be tested without one. */
export interface Lane {
  handle: (req: DaemonRequest) => Promise<DaemonResponse>;
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  timeoutMs: number;
  reply: (res: DaemonResponse) => void;
}

/** Route one request onto the urgent or the queued lane.
 *
 *  Urgent ops skip the serializer: they exist to be answerable while another
 *  op is wedged, which is the whole point of `shutdown` being able to kill a
 *  stuck daemon. Which ops those are is declared by `urgent: true` on the op
 *  in `DaemonOps`, not spelled here, so adding one is a marker rather than a
 *  branch.
 *
 *  The queued lane serializes on the UNDERLYING op, not the timeout: the
 *  WebView lock is held until `handle(req)` actually settles, so a
 *  timed-out-but-still-running op can never overlap the next one.
 *  `withTimeout` only governs how soon the client is answered. */
export function dispatch(req: DaemonRequest, lane: Lane): void {
  if (IS_URGENT.has(req.op)) {
    lane.handle(req).then(lane.reply).catch(() => {
      // handle() never rejects; mirrors the guard on the serialized path.
    });
    return;
  }
  lane.serialize(() => {
    const underlying = lane.handle(req);
    withTimeout(underlying, lane.timeoutMs, req.op).then(lane.reply, (err) => {
      // handle() catches its own errors; this path is for timeouts.
      const msg = err instanceof Error ? err.message : String(err);
      lane.reply({ id: req.id, ok: false, error: msg });
    });
    return underlying;
  }).catch(() => {
    // handle() never rejects; guards against an unhandled rejection.
  });
}

/** Per-operation timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

// `state` is excluded: it alone needs the DaemonState the daemon owns, so
// createHandler() answers it with a closure instead of an entry here.
type Handlers = {
  [O in Exclude<Op, "state">]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
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
 *  including an op name that is not in the map, is a `{ ok: false }` reply.
 *
 *  `state` defaults to `{}` so the 13 existing call sites that pass only a
 *  browser keep compiling unchanged; only the `state` op reads it. */
export function createHandler(browser: Browser, state: DaemonState = {}): (req: DaemonRequest) => Promise<DaemonResponse> {
  return async (req) => {
    // `state` is answered by a closure, not an entry in `handlers`: it is the
    // one op that reads DaemonState, and threading a third parameter through
    // the other ~30 handlers for that would be a change with one consumer.
    const fn = req.op === "state"
      ? async (b: Browser): Promise<PageState> => ({
          url: await b.realUrl(),
          title: await b.realTitle(),
          ...(state.dialog ? { dialog: state.dialog } : {}),
        })
      : Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
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
  const state: DaemonState = {};
  const handle = createHandler(browser, state);
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
          dispatch(req, { handle, serialize, timeoutMs, reply: (res) => {
            socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
          } });
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
