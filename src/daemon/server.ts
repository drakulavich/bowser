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
import pkg from "../../package.json";
import { openBrowser, type ActPhase, type Browser } from "../browser.ts";
import { createSerializer, type Serializer } from "../serialize.ts";
import { createGate, type Gate } from "./gate.ts";
import { opTimeoutMs } from "../budget.ts";
import { lineReader } from "../socket-lines.ts";
import { socketWriteAll, flushSocket, type WritableSocket } from "../socket-write.ts";
import {
  IS_URGENT,
  type ArgsOf, type DaemonRequest, type DaemonResponse, type DialogReport, type DialogState, type Op, type PageState, type ResultOf,
} from "./protocol.ts";
import { pidPath, socketPath } from "./client.ts";
import { claimSession } from "./pidfile.ts";
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
  /** `deadline` (epoch ms) is when the request's own timer is about to fire. */
  handle: (req: DaemonRequest, deadline?: number) => Promise<DaemonResponse>;
  serialize: Serializer;
  timeoutMs: number;
  reply: (res: DaemonResponse) => void;
  /** Called when `req` overran its budget: gives up its late reply's reports
   *  and returns those queued now, which the timeout reply carries. */
  timedOut?: (req: DaemonRequest) => DialogReport[] | undefined;
  cancelAction?: () => void;
  /** Try once to free the WebView from the op that just overran its budget;
   *  resolves when the attempt is over, true when it freed the view. */
  recover?: () => Promise<boolean>;
  phase?: () => ActPhase;
  /** The session's stuck mark: one object shared by every request's lane. */
  mark?: StuckMark;
  /** The session's gate and this request's connection: with both, a queued
   *  request waits until its connection holds the gate (#77). */
  gate?: Gate;
  conn?: object;
}

/** Set while an op that timed out is still running after its recovery. That
 *  op holds the serializer, so it is the only one that can be stuck. */
export interface StuckMark {
  stuck?: { op: string };
  /** The requests waiting at the gate or the serializer: each is answered
   *  stuck when the mark is set. */
  waiting?: Set<(op: string) => void>;
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
 *
 *  The budget is one timer per request, started here, on receipt, so it
 *  counts queue time. At the deadline:
 *  - a request that is running gets the timeout reply. If it is still
 *    running after a grace of RECOVERY_GRACE_MS (or the budget, if
 *    smaller), `recover` runs once, for it. An op that was only slow and
 *    settles within the grace is left alone, so its page survives;
 *  - a request still queued behind an op that timed out gets its own error
 *    naming that op, and is dropped when its turn comes, since its client
 *    has already been told it failed;
 *  - a request still waiting at the gate for another connection's commands
 *    says so, and is dropped the same way.
 *  If the op is still running once `recover` resolves, whatever it returned,
 *  the session is marked stuck until the op settles. Every request waiting
 *  then is answered at once, and so is one that arrives or reaches the gate
 *  meanwhile, which enters neither the gate nor the serializer.
 *  Every request ahead of a queued one arrived earlier with the same budget,
 *  so the op it waits for has always timed out first. */
/** How long a timed-out op may still settle on its own before `recover`
 *  reloads the page under it (capped by the budget). */
const RECOVERY_GRACE_MS = 2000;
/** How long before its timer a handler's own failure is due, so that failure,
 *  not the plain timeout, is what the client hears. */
const REPLY_MARGIN_MS = 50;

export function dispatch(req: DaemonRequest, lane: Lane): void {
  if (IS_URGENT.has(req.op)) {
    lane.handle(req).then(lane.reply).catch(() => {
      // handle() never rejects; mirrors the guard on the serialized path.
    });
    return;
  }
  if (lane.mark?.stuck) {
    lane.reply({ id: req.id, ok: false, error: stuckMessage(lane.mark.stuck.op) });
    return;
  }
  const total = req.budgetTotalMs;
  const budget = total !== undefined && (lane.timeoutMs <= 0 || total < lane.timeoutMs) ? total : lane.timeoutMs || Math.max(req.budgetMs ?? 0, 0);
  if (req.budgetMs !== undefined && req.budgetMs <= 0) {
    lane.reply({ id: req.id, ok: false, error: timeoutMessage(req, budget) });
    return;
  }
  let answered = false;
  let running = false;
  let settled = false;
  let atGate = false;
  let leaveGate: (() => void) | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let recovery: Promise<unknown> | undefined;
  const mine = { op: req.cmd ?? req.op };
  const onStuck = (op: string): void => {
    answer({ id: req.id, ok: false, error: stuckMessage(op) });
    // Still queued at the gate: it would later hold it with nothing to release it.
    if (atGate && !leaveGate && lane.conn) lane.gate?.leave(lane.conn);
  };
  const waiting = lane.mark ? (lane.mark.waiting ??= new Set()) : undefined;
  waiting?.add(onStuck);
  const answer = (res: DaemonResponse): void => {
    if (answered) return;
    answered = true;
    waiting?.delete(onStuck);
    clearTimeout(timer);
    lane.reply(res);
    // On answer, not on settle: a timed-out op still running holds only the
    // serializer, so the next client gets its "waiting for" hint (F9).
    leaveGate?.();
  };
  const ms = req.budgetMs !== undefined && (lane.timeoutMs <= 0 || req.budgetMs < lane.timeoutMs) ? req.budgetMs : lane.timeoutMs;
  const deadline = ms > 0 ? Date.now() + ms - REPLY_MARGIN_MS : undefined;
  const timer = ms > 0 ? setTimeout(() => {
    const timedOut = timeoutMessage(req, budget, running ? lane.phase?.() : undefined);
    if (atGate) {
      answer({ id: req.id, ok: false, error: `${timedOut} (waiting for another client's command on this session)` });
      return;
    }
    if (!running) {
      const prev = lane.serialize.running ?? "an earlier operation";
      answer({ id: req.id, ok: false, error: `${timedOut} (waiting for '${prev}', which timed out and is still running; run 'bowser close' if the session stays stuck)` });
      return;
    }
    const dialogs = lane.timedOut?.(req);
    lane.cancelAction?.();
    answer({ id: req.id, ok: false, error: timedOut, ...(dialogs ? { dialogs } : {}) });
    // Runs while this op still holds the serializer, so no later queued op
    // can overlap it; see Browser.interrupt for what it may overlap.
    const graceMs = Math.min(RECOVERY_GRACE_MS, ms);
    let watched = false;
    const recover = (): void => {
      // The action returned and the watch ends on its own unless it sees a
      // navigation: a reload now would only throw away the page (#115).
      if (lane.phase?.() === "delivered") {
        watched = true;
        grace = setTimeout(recover, 10);
        return;
      }
      if (watched) {
        watched = false;
        grace = setTimeout(recover, graceMs);
        return;
      }
      recovery = lane.recover?.().catch(() => false).then(() => {
        if (settled || !lane.mark) return;
        lane.mark.stuck = mine;
        for (const w of [...waiting ?? []]) w(mine.op);
      });
    };
    grace = setTimeout(recover, graceMs);
  }, ms) : undefined;
  const queue = (): void => {
    lane.serialize(async () => {
      if (answered) return;
      running = true;
      waiting?.delete(onStuck);
      const res = await lane.handle(req, deadline);
      settled = true;
      if (lane.mark?.stuck === mine) lane.mark.stuck = undefined;
      // Settled within the grace: no reload, and the next op starts now.
      clearTimeout(grace);
      answer(res);
      // Hold the lane until the recovery's reload has landed, so the next op
      // sees the page it left rather than racing it.
      await recovery;
    }, req.op).catch(() => {
      // handle() never rejects; guards against an unhandled rejection.
    });
  };
  if (!lane.gate || !lane.conn) {
    queue();
    return;
  }
  atGate = true;
  lane.gate.enter(lane.conn).then((done) => {
    atGate = false;
    if (answered) done();
    else {
      leaveGate = done;
      queue();
    }
  }, () => {
    // Its connection closed while it waited: nobody is left to answer.
    answered = true;
    waiting?.delete(onStuck);
    clearTimeout(timer);
  });
}

function stuckMessage(op: string): string {
  return `session is stuck: '${op}' is still running after a reload; run 'bowser close'`;
}

/** A timeout names the command the user ran, and the op when it is one of
 *  the command's steps: `fill` sends `click` first, and `snapshot` and
 *  `eval` both send `evaluate` (F21). A request with no `cmd` is its op. */
function timeoutMessage(req: DaemonRequest, ms: number, phase?: ActPhase): string {
  const cmd = req.cmd ?? req.op;
  if (phase === "awaiting-navigation") {
    if (cmd !== req.op) {
      return `'${cmd}' timed out after ${ms}ms waiting for the page its ${req.op} opened; the ${req.op} was delivered but the ${cmd} did not finish, check the page before retrying`;
    }
    return `'${cmd}' timed out after ${ms}ms waiting for the page it opened; the ${cmd} was delivered, check the page before retrying`;
  }
  const step = cmd === req.op ? "" : ` (in its '${req.op}' step)`;
  if (phase === "acting" || phase === "delivered") {
    const how = phase === "acting" ? "may have been delivered" : "was delivered";
    const unfinished = cmd === req.op ? "" : ` but the ${cmd} did not finish`;
    return `'${cmd}' timed out after ${ms}ms${step}; the ${req.op} ${how}${unfinished}, check the page before retrying`;
  }
  return `'${cmd}' timed out after ${ms}ms${step}`;
}

// `state` and `dialog-answer` are excluded: they alone need the DaemonState
// the daemon owns, so createHandler() answers them with closures instead.
type Handlers = {
  [O in Exclude<Op, "state" | "dialog-answer">]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
};

const handlers: Handlers = {
  // The version, so a client of another version refuses this daemon (F2).
  ping: async () => pkg.version,
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
  resolve: (browser, expr) => browser.evaluate(expr),
  click: (browser, selector, timeoutMs) => browser.click(selector, timeoutMs),
  type: (browser, text) => browser.type(text),
  press: (browser, key, modifiers) => browser.press(key, modifiers),
  hover: (browser, selector) => browser.hover(selector),
  select: (browser, selector, value) => browser.select(selector, value),
  check: async (browser, selector) => { await browser.setChecked(selector, true); },
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

/** What WebKit answers every evaluate and click with once the page's web
 *  process has died twice: the first time the engine relaunches it and
 *  reloads the page, the second time it does not (spec F34, measured on Bun
 *  1.4.2). No page value gives this message: evaluate serializes page-side. */
const DEAD_PAGE = "JavaScript execution returned a result of an unsupported type";
const PAGE_CRASHED = "the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'";

/** What createHandler returns: the request handler, and the hook `dispatch`
 *  calls when a request overruns its budget. */
export type Handler = ((req: DaemonRequest, deadline?: number) => Promise<DaemonResponse>) & {
  timedOut: (req: DaemonRequest) => DialogReport[] | undefined;
  cancelAction: () => void;
};

/** The answer of a script that returns PAGE_JSON text (withDialogShim and
 *  the dialog scripts in src/page-scripts.ts), parsed. Anything else reads
 *  as no answer: only a page that replaced JSON.stringify itself gives it,
 *  and before #76 such a page's answer was empty too. */
function fromPage(raw: unknown): unknown {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

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
  const handle = async (req: DaemonRequest, deadline?: number): Promise<DaemonResponse> => {
    // An urgent op runs beside a timed-out one; clearing it would let that op still act.
    if (!IS_URGENT.has(req.op)) browser.resetActionCancellation?.();
    // A ref resolved before the pending navigation lands would be acted on
    // in the next document (#105).
    const res = ACTS.has(req.op) || req.op === "resolve" ? await afterPendingNavigation(req, deadline) : await runShimmed(req);
    const dialogs = claim(req);
    return dialogs ? { ...res, dialogs } : res;
  };
  // A request can overrun with reports queued: an op that prints none (a
  // state-save's evaluate, say) left them, or this op's own sync before a
  // native action took them just before the action wedged. The timeout
  // reply carries them, since the late reply will reach nobody.
  return Object.assign(handle, {
    cancelAction: () => browser.cancelAction?.(),
    timedOut: (req: DaemonRequest) => {
      const dialogs = claim(req);
      abandoned.add(req);
      return dialogs;
    },
  });

  /** Wait, up to `deadline`, for a navigation an earlier action left
   *  pending: an action must not start before it ends (ET-10, #78). */
  async function afterPendingNavigation(req: DaemonRequest, deadline = Infinity): Promise<DaemonResponse> {
    if (!browser.navigationPending) return runShimmed(req, deadline);
    // Read before the wait: after it, the reply is due at once.
    const url = await browser.navigationDestination(Math.max(0, deadline - Date.now()));
    while (browser.navigationPending) {
      const left = deadline - Date.now();
      if (left <= 0) return { id: req.id, ok: false, error: `page is still loading ${url}; retry later, or run 'bowser close'` };
      await Bun.sleep(Math.min(10, left));
    }
    return runShimmed(req, deadline);
  }

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
          take(fromPage(await b.evaluate(dialogAnswerScript(text === undefined ? { accept } : { accept, text }))));
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
      return { id: req.id, ok: false, error: msg.includes(DEAD_PAGE) ? PAGE_CRASHED : msg };
    }
  }

  /** `run`, with the page shim that answers dialogs. It must be in the page
   *  before an op acts there, and its log is read after. An eval carries
   *  both in its own expression, so it costs no extra page call. An op that
   *  may leave the document (every ACTS and NAVIGATES op) costs one read
   *  before it and one after: a dialog a timer opened since the last op is
   *  in the log of the document the op may leave, and the log leaves with
   *  it. The reads are page evaluates inside the daemon, not socket round
   *  trips (~0.07 ms each on WebKit, measured). */
  async function runShimmed(req: DaemonRequest, deadline = Infinity): Promise<DaemonResponse> {
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
      const r = fromPage(res.result) as { value?: unknown; dialogs?: unknown } | undefined;
      take(r?.dialogs);
      return r?.value === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result: r.value };
    }
    if (!ACTS.has(req.op) && !NAVIGATES.has(req.op)) return run(req);
    // Before: an action installs the shim if the page lacks it; either op
    // reads the log of a page that has it. A navigating op on a page with no
    // shim has no log to read.
    if (ACTS.has(req.op) || shimmed) await sync();
    // A navigating op leaves this document, so the sync after it drops the
    // page's answer: a document the back-forward cache restores still has
    // its shim and answer. Not left to the navigation callback alone.
    if (NAVIGATES.has(req.op)) shimmed = false;
    // Bun's click otherwise waits 30 s for a covered target, past the
    // recovery reload, which leaves the session stuck (#112).
    const res = await run(req.op === "click" && deadline !== Infinity
      ? { ...req, args: [req.args?.[0], Math.max(0, deadline + REPLY_MARGIN_MS - Date.now())] }
      : req);
    await sync();
    return res;
  }

  /** Install the shim if the page lacks it, and take its log. */
  async function sync(): Promise<void> {
    try {
      take(fromPage(await browser.evaluate(dialogSyncScript(!shimmed))));
      shimmed = true;
    } catch {
      // A page that cannot evaluate right now opened no dialog we can read.
    }
  }

  /** Queue the dialogs the page shim logged. The page wrote them, so only
   *  entries shaped like a report are kept, rebuilt from the known fields
   *  (F27): anything else the page added never reaches the reply. */
  function take(log: unknown): void {
    if (!Array.isArray(log)) return;
    for (const d of log) {
      if (!DIALOG_TYPES.has(d?.type) || typeof d.message !== "string" || (d.state !== "accepted" && d.state !== "dismissed")) continue;
      // In the shim's key order, which --json prints.
      const report: DialogReport = {
        type: d.type,
        message: d.message,
        ...(typeof d.defaultValue === "string" ? { defaultValue: d.defaultValue } : {}),
        state: d.state,
        ...(typeof d.answer === "string" ? { answer: d.answer } : {}),
        ...(d.unanswered === true ? { unanswered: true as const } : {}),
      };
      (state.dialogs ??= []).push(report);
    }
  }
}

/** The ops that act on the current document by native input or a page
 *  script of their own: the shim must be there first. */
export const ACTS: ReadonlySet<Op> = new Set<Op>(["click", "type", "press", "hover", "select", "check", "uncheck"]);

/** The ops that navigate the page themselves. */
const NAVIGATES: ReadonlySet<Op> = new Set<Op>(["navigate", "reload", "back", "forward"]);

/** The dialog types a report may name (DialogState's union). */
const DIALOG_TYPES: ReadonlySet<unknown> = new Set<DialogState["type"]>(["alert", "confirm", "prompt"]);

/** Start the session's daemon. Resolves false, having touched nothing, when
 *  another daemon of ours already holds the session: the caller then exits.
 *  Resolves true once this daemon is listening. */
export async function startDaemon(session: string, profile?: string): Promise<boolean> {
  // Claim the session before anything else (F29). A pidfile is the claim: it
  // is created exclusively, so of several daemons racing for one session only
  // one gets past here, and a loser leaves the winner's socket and pidfile
  // alone. `close` also reads it to confirm this process died rather than
  // assuming it.
  const pidFile = pidPath(session);
  if (!(await claimSession(pidFile, session))) return false;
  // Removed on the way out — a pidfile outliving its process is the stale
  // state the claim has to clear. An exit handler catches every path out,
  // not just `shutdown`, so it must be synchronous.
  process.on("exit", () => {
    removePidFileIfOwned(pidFile, process.pid);
  });

  // The session is ours, so a socket file left here is stale.
  const sock = socketPath(session);
  try {
    await unlink(sock);
  } catch {}

  const browser: Browser = await openBrowser({ profile });
  const state: DaemonState = profile ? { profile } : {};
  const handle = createHandler(browser, state);
  const serialize = createSerializer();
  const timeoutMs = opTimeoutMs();
  const gate = createGate(timeoutMs);
  const mark: StuckMark = {};

  // Each connection's line reader lives on its socket's `data`, with the
  // object the gate knows it by.
  Bun.listen<{ read: (chunk: Uint8Array) => void; conn: object }>({
    unix: sock,
    socket: {
      data(socket, data) {
        socket.data.read(data);
      },
      open(socket) {
        const conn = {};
        // Requests are newline-delimited, one reader per connection.
        socket.data = { conn, read: lineReader((line) => {
          if (!line) return;
          let req: DaemonRequest;
          try {
            req = JSON.parse(line) as DaemonRequest;
          } catch (err) {
            socketWriteAll(
              socket as unknown as WritableSocket,
              JSON.stringify({ id: -1, ok: false, error: "invalid JSON: " + String(err) }) + "\n",
            );
            return;
          }
          dispatch(req, { handle, serialize, gate, conn, mark, timeoutMs, timedOut: handle.timedOut, cancelAction: handle.cancelAction, recover: () => browser.interrupt(), phase: () => browser.phase, reply: (res) => {
            socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
          } });
        }) };
      },
      close(socket) {
        gate.leave(socket.data.conn);
      },
      drain(socket) {
        flushSocket(socket as unknown as WritableSocket);
      },
      error(socket, err) {
        console.error("[bowser daemon] socket error:", err.message);
        gate.leave(socket.data.conn);
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
  return true;
}
