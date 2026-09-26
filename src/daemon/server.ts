// Per-session daemon. A long-lived Bun process holds one Bun.WebView and
// services client commands over a Unix socket. This is what gives Bowser
// real stateful multi-step flows — a fresh browser per command would lose
// everything the page accumulated (typed text, modals, dynamic DOM).
//
// The op set lives in ./protocol.ts. `handlers` below is typed from it, so
// an op without a handler here does not compile. `state` and
// `dialog-answer` are the exceptions and are answered by closures in
// createHandler(), because they alone use the daemon's own state, which a
// handlers entry is not given. Removing either closure does not compile either, for a
// different reason: req.op spans every op, and Handlers excludes them, so the
// lookup stops being index-safe.
//
// Dialogs: none ever stays open. WebKit has no dialog events, so a page shim
// (page-scripts.ts dialogShim) answers each dialog the moment it opens (the
// one-shot answer if set, else dismiss) and holds that answer in the page;
// the daemon reads its log (createHandler), and the op's reply reports it.

import { unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { openBrowser, type Browser } from "../browser.ts";
import { createSerializer, withTimeout } from "../serialize.ts";
import { socketWriteAll, flushSocket, type WritableSocket } from "../socket-write.ts";
import {
  IS_URGENT,
  type ArgsOf, type DaemonRequest, type DaemonResponse, type DialogReport, type Op, type PageState, type ResultOf,
} from "./protocol.ts";
import { pidPath, socketPath } from "./client.ts";
import { dialogAnswerScript, dialogSyncScript, withDialogShim } from "../page-scripts.ts";

/** What the daemon knows that the page cannot be asked for. `url` and `title`
 *  are deliberately NOT here: they are read live from the page on every
 *  `state` call, because an action can navigate and a cached copy would go
 *  stale (that regression is why `nav.act()` exists). */
export interface DaemonState {
  /** Dialogs answered since the last queued op's reply, which reports them. */
  dialogs?: DialogReport[];
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
  /** Called when `req` overran its budget: gives up its late reply's reports
   *  and returns those queued now, which the timeout reply carries. */
  timedOut?: (req: DaemonRequest) => DialogReport[] | undefined;
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
      const dialogs = lane.timedOut?.(req);
      lane.reply({ id: req.id, ok: false, error: msg, ...(dialogs ? { dialogs } : {}) });
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
type Handlers = {
  [O in Exclude<Op, "state" | "dialog-answer">]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
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
};

/** What createHandler returns: the request handler, and the hook `dispatch`
 *  calls when a request overruns its budget. */
export type Handler = ((req: DaemonRequest) => Promise<DaemonResponse>) & {
  timedOut: (req: DaemonRequest) => DialogReport[] | undefined;
};

/** Dispatch one parsed request to its handler. Never rejects: every failure,
 *  including an op name that is not in the map, is a `{ ok: false }` reply.
 *
 *  `state` defaults to `{}` so call sites that pass only a browser keep
 *  compiling unchanged. */
export function createHandler(browser: Browser, state: DaemonState = {}): Handler {
  // Whether the page has the shim, as far as the daemon knows. False after a
  // navigation, which also means the page's answer must be dropped.
  let shimmed = false;
  browser.watchNavigation(() => { shimmed = false; });
  // Requests that overran their budget: their late replies reach nobody, so
  // they must not take reports.
  const abandoned = new WeakSet<DaemonRequest>();
  const claim = (req: DaemonRequest): DialogReport[] | undefined => {
    // Only a command that prints dialogs takes the reports (never an urgent
    // reply, such as the ping every connect sends); the rest leave them queued.
    if (!req.report || IS_URGENT.has(req.op) || abandoned.has(req) || !state.dialogs) return undefined;
    const dialogs = state.dialogs;
    state.dialogs = undefined;
    return dialogs;
  };
  const handle = async (req: DaemonRequest): Promise<DaemonResponse> => {
    const res = await runShimmed(req);
    const dialogs = claim(req);
    return dialogs ? { ...res, dialogs } : res;
  };
  // A request can overrun with reports queued: an op that prints none (a
  // state-save's evaluate, say) left them, or this op's own sync before a
  // native action took them just before the action wedged. The timeout
  // reply carries them, since the late reply will reach nobody.
  return Object.assign(handle, {
    timedOut: (req: DaemonRequest) => {
      const dialogs = claim(req);
      abandoned.add(req);
      return dialogs;
    },
  });

  async function run(req: DaemonRequest): Promise<DaemonResponse> {
    // `state` and `dialog-answer` are answered by closures, not entries in
    // `handlers`: they are the ops that use the daemon's own state, and
    // threading it through the other handlers would be a change with two
    // consumers.
    const fn = req.op === "state"
      ? async (b: Browser): Promise<PageState> => ({
          url: await b.realUrl(),
          title: await b.realTitle(),
          ...(state.profile ? { profile: state.profile } : {}),
        })
      : req.op === "dialog-answer"
      ? async (b: Browser, accept: boolean, text?: string): Promise<void> => {
          // The shim holds the one-shot answer in the page, so a new
          // document starts without one.
          take(await b.evaluate(dialogAnswerScript(text === undefined ? { accept } : { accept, text })));
          shimmed = true;
        }
      : Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
    if (!fn) return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
    try {
      // The one cast at the wire boundary: args arrived as JSON, the handler
      // is typed for this op. Everything below this line is typed.
      const result = await (fn as (b: Browser, ...a: unknown[]) => Promise<unknown>)(browser, ...(req.args ?? []));
      return result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: req.id, ok: false, error: msg };
    }
  }

  /** `run`, with the page shim that answers dialogs. It must be in the page
   *  before an op acts there, and its log is read after. An eval carries
   *  both in its own expression, so it costs no extra page call; a native
   *  action costs one read after it, and one install before it only after a
   *  navigation. */
  async function runShimmed(req: DaemonRequest): Promise<DaemonResponse> {
    if (req.op === "evaluate") {
      const drop = !shimmed;
      const res = await run({ ...req, args: [withDialogShim(String(req.args?.[0]), drop)] });
      // A throwing expression never returned its log: read it now, so the
      // error reports the dialogs too. It may have run nothing, so the read
      // also installs the shim when the page lacks it.
      if (!res.ok) {
        await sync();
        return res;
      }
      shimmed = true;
      const r = res.result as { value?: unknown; dialogs?: unknown } | undefined;
      take(r?.dialogs);
      return r?.value === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result: r.value };
    }
    if (!ACTS.has(req.op) && !NAVIGATES.has(req.op)) return run(req);
    // A navigating op leaves this document, so the sync after it drops the
    // page's answer: a document the back-forward cache restores still has
    // its shim and answer. Not left to the navigation callback alone.
    if (NAVIGATES.has(req.op)) shimmed = false;
    if (ACTS.has(req.op) && !shimmed) await sync();
    const res = await run(req);
    await sync();
    return res;
  }

  /** Install the shim if the page lacks it, and take its log. */
  async function sync(): Promise<void> {
    try {
      take(await browser.evaluate(dialogSyncScript(!shimmed)));
      shimmed = true;
    } catch {
      // A page that cannot evaluate right now opened no dialog we can read.
    }
  }

  /** Queue the dialogs the page shim logged. The page wrote them, so only
   *  entries shaped like a report are kept. */
  function take(log: unknown): void {
    if (!Array.isArray(log)) return;
    for (const d of log) {
      if (typeof d?.type === "string" && typeof d.message === "string" && (d.state === "accepted" || d.state === "dismissed")) {
        (state.dialogs ??= []).push(d as DialogReport);
      }
    }
  }
}

/** The ops that act on the current document by native input or a page
 *  script of their own: the shim must be there first. */
const ACTS: ReadonlySet<Op> = new Set<Op>(["click", "type", "press", "hover", "select", "check", "uncheck"]);

/** The ops that navigate the page themselves. */
const NAVIGATES: ReadonlySet<Op> = new Set<Op>(["navigate", "reload", "back", "forward"]);

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
          dispatch(req, { handle, serialize, timeoutMs, timedOut: handle.timedOut, reply: (res) => {
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
