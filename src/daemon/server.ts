// Per-session daemon. A long-lived Bun process holds one Bun.WebView and
// services client commands over a Unix socket. This is what gives Bowser
// real stateful multi-step flows — a fresh browser per command would lose
// everything the page accumulated (typed text, modals, dynamic DOM).
//
// The op set lives in ./protocol.ts. `handlers` below is typed from it, so
// an op without a handler here does not compile. `state` is the exception
// and is answered by a closure in createHandler(), because it alone reads
// DaemonState, which a handlers entry is not given (`dialog-answer` too).
// Removing either closure does not compile, for a different reason: req.op
// spans every op, and Handlers excludes them, so the lookup stops being
// index-safe.
//
// Dialogs (chrome): a page op that opens one answers as soon as it is open,
// with the dialog pending, instead of waiting for the page it blocks; the op
// itself settles in the background once `dialog-answer` (urgent lane) has
// answered it. While one is pending every other queued op fails at once, so
// nothing can queue behind it. `dialog-answer` then waits briefly for the
// blocked call to settle; if it has not, the page stays busy until it does,
// and page ops fail at once meanwhile. No op ever waits on it, so none can be
// reported failed and still reach the browser.

import { unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { CDP_UNAVAILABLE, openBrowser, type Browser } from "../browser.ts";
import { createSerializer, withTimeout } from "../serialize.ts";
import { socketWriteAll, flushSocket, type WritableSocket } from "../socket-write.ts";
import {
  IS_URGENT, REQUIRES_CDP, dialogOpenError,
  type ArgsOf, type DaemonRequest, type DaemonResponse, type DialogReport, type DialogState, type Op, type PageState, type ResultOf,
} from "./protocol.ts";
import { pidPath, socketPath } from "./client.ts";

/** What the daemon knows that the page cannot be asked for. `url` and `title`
 *  are deliberately NOT here: they are read live from the page on every
 *  `state` call, because an action can navigate and a cached copy would go
 *  stale (that regression is why `nav.act()` exists). */
export interface DaemonState {
  /** The open dialog (chrome). Set by the page, cleared by dialog-answer or
   *  when the page closes it. */
  dialog?: DialogState;
  /** The one-shot answer for the next dialog; dropped on navigation. On
   *  webkit nothing reads it yet: the page shim (Task 2) will. */
  answer?: { accept: boolean; text?: string };
  /** Dialogs the daemon answered that no reply has reported yet. */
  handled?: DialogReport[];
  /** The persistent profile directory the browser opened with; absent when
   *  its store is ephemeral. Fixed for the daemon's life. */
  profile?: string;
}

/** Remove only this daemon's pidfile. A replacement can overwrite the path
 *  before the old process's exit handler runs. */
export function removePidFileIfOwned(pidFile: string, pid: number): void {
  try {
    if (readFileSync(pidFile, "utf8").trim() === String(pid)) unlinkSync(pidFile);
  } catch {}
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

// `state` and `dialog-answer` are excluded: they alone need the DaemonState
// the daemon owns, so createHandler() answers them with closures instead.
type Stateful = "state" | "dialog-answer";
type Handlers = {
  [O in Exclude<Op, Stateful>]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
};

/** Ops a pending dialog does not refuse: the urgent ones (`ping` for list and
 *  every connect, `shutdown` for close, `dialog-answer`), and `state`,
 *  which the command that opened the dialog reads right after. */
const PASS_A_DIALOG: ReadonlySet<Op> = new Set<Op>([...IS_URGENT, "state"]);

/** How long `dialog-answer` waits for the call its dialog blocked. Normally
 *  that call settles within milliseconds of the answer. */
export const DIALOG_SETTLE_MS = 2000;

/** The fail-fast error while a call a dialog blocked is still settling. */
function busyError(op: Op): string {
  return `the page is still finishing ${op} after a dialog; try again`;
}

/** The prompt text a dialog is answered with: a prompt's, when accepted. */
function promptText(d: DialogState, accept: boolean, text?: string): string | undefined {
  return d.type === "prompt" && accept ? text ?? d.defaultValue ?? "" : undefined;
}

function answered(d: DialogState, accept: boolean, answer?: string): DialogReport {
  return { ...d, state: accept ? "accepted" : "dismissed", ...(answer !== undefined ? { answer } : {}) };
}

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
 *  `state` defaults to `{}` so the call sites that pass only a browser keep
 *  compiling unchanged; only `state`, `dialog-answer` and the dialog
 *  listener read it. `settleMs` is how long `dialog-answer` waits for the
 *  call its dialog blocked (tests shorten it). */
export function createHandler(browser: Browser, state: DaemonState = {}, settleMs = DIALOG_SETTLE_MS): (req: DaemonRequest) => Promise<DaemonResponse> {
  // Wakes the op in flight when its dialog opens.
  const waiters = new Set<() => void>();
  // The browser call a dialog blocked, after its op already replied. It still
  // owns the page until it settles; its own `finally` clears this.
  let blocked: { op: Op; done: Promise<unknown> } | undefined;
  browser.watchDialogs({
    opened: (d) => {
      const a = state.answer;
      if (a) {
        state.answer = undefined;
        const text = promptText(d, a.accept, a.text);
        browser.answerDialog(a.accept, text).catch(() => {});
        (state.handled ??= []).push(answered(d, a.accept, text));
        return;
      }
      state.dialog = d;
      for (const wake of waiters) wake();
    },
    closed: () => { state.dialog = undefined; },
    navigated: () => { state.answer = undefined; },
  });

  const stateful: { [O in Stateful]: (b: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>> } = {
    // While a dialog is open or a blocked call is settling (chrome only) the
    // page cannot evaluate, so url and title come from the browser's own view
    // of the target (pageInfo) instead of realUrl()/realTitle().
    state: async (b) => {
      const page = state.dialog || blocked
        ? await b.pageInfo()
        : { url: await b.realUrl(), title: await b.realTitle() };
      return {
        ...page,
        ...(state.dialog ? { dialog: state.dialog } : {}),
        ...(state.profile ? { profile: state.profile } : {}),
      };
    },
    "dialog-answer": async (b, accept, text) => {
      const d = state.dialog;
      if (!d) {
        state.answer = text === undefined ? { accept } : { accept, text };
        return {};
      }
      const answer = promptText(d, accept, text);
      await b.answerDialog(accept, answer);
      // Only this dialog: the page may already have opened the next one.
      if (state.dialog === d) state.dialog = undefined;
      // Give the blocked call a moment to finish, so the next command finds
      // the page free. Stop early if it opens another dialog instead.
      if (blocked && !state.dialog) {
        let wake!: () => void;
        const next = new Promise<void>((r) => { wake = r; });
        waiters.add(wake);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([blocked.done, next, new Promise<void>((r) => { timer = setTimeout(r, settleMs); })]);
        clearTimeout(timer);
        waiters.delete(wake);
      }
      return { answered: answered(d, accept, answer) };
    },
  };

  const run = async (req: DaemonRequest): Promise<DaemonResponse> => {
    const fn = req.op === "state" || req.op === "dialog-answer"
      ? stateful[req.op]
      : Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
    if (!fn) return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
    if (state.dialog && !PASS_A_DIALOG.has(req.op)) {
      return { id: req.id, ok: false, error: dialogOpenError(state.dialog) };
    }
    // After the answer, the call the dialog blocked may still be settling;
    // refuse rather than overlap it. Checked after the dialog guard, so a
    // second dialog is reported first.
    if (blocked && !PASS_A_DIALOG.has(req.op)) {
      return { id: req.id, ok: false, error: busyError(blocked.op) };
    }
    // Capability gate: a CDP-only op on webkit fails here with the shared
    // message, so the handler never touches a view that cannot answer.
    if (REQUIRES_CDP.has(req.op) && !browser.cdpAvailable()) {
      return { id: req.id, ok: false, error: CDP_UNAVAILABLE };
    }
    // Race the op against a dialog opening: the page stays blocked until the
    // dialog is answered, so waiting for `work` here would wedge the session.
    // Listen before the op starts; its dialog can open before it yields.
    // A `state` caught by one is simply asked again, now from the getters.
    let wake!: () => void;
    const opened = new Promise<void>((r) => { wake = r; });
    if (!IS_URGENT.has(req.op)) waiters.add(wake);
    // The one cast at the wire boundary: args arrived as JSON, the handler
    // is typed for this op. Everything below this line is typed.
    const work = (async () => (fn as (b: Browser, ...a: unknown[]) => Promise<unknown>)(browser, ...(req.args ?? [])))().then(
      (result): DaemonResponse => result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result },
      (err): DaemonResponse => ({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    if (IS_URGENT.has(req.op)) return work;
    try {
      return await Promise.race([
        work,
        opened.then(() => {
          const mark = { op: req.op, done: work };
          blocked = mark;
          work.finally(() => { if (blocked === mark) blocked = undefined; });
          return req.op === "state" ? run(req) : { id: req.id, ok: true };
        }),
      ]);
    } finally {
      waiters.delete(wake);
    }
  };

  return async (req) => {
    const res = await run(req);
    if (IS_URGENT.has(req.op)) return res;
    const dialogs = [...(state.handled ?? []), ...(state.dialog ? [{ ...state.dialog, state: "pending" as const }] : [])];
    state.handled = undefined;
    return dialogs.length > 0 ? { ...res, dialogs } : res;
  };
}

export async function startDaemon(session: string, profile?: string): Promise<void> {
  const sock = socketPath(session);
  // Clean up any stale socket file.
  try {
    await unlink(sock);
  } catch {}

  // Record the pid so `close` can confirm this process died rather than
  // assuming it. Removed on the way out — a pidfile outliving its process is
  // the same stale state this exists to detect. An exit handler catches every
  // path out, not just `shutdown`, so it must be synchronous.
  const pidFile = pidPath(session);
  await Bun.write(pidFile, String(process.pid));
  process.on("exit", () => {
    removePidFileIfOwned(pidFile, process.pid);
  });

  const browser: Browser = await openBrowser({ profile });
  const state: DaemonState = profile ? { profile } : {};
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
