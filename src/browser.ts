// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView, always with the native WebKit backend (macOS).

import {
  CANCEL_PENDING_NAVIGATION,
  KEY_CODES,
  LEAVE_INITIAL_DOCUMENT,
  LANDED_PAGE,
  ENTRY_KEY,
  DOC_ID,
  LOAD_STATE,
  MUTE_MEDIA,
  NAV_ARM,
  NAV_COUNT,
  NAV_DESTINATION,
  NO_OP,
  READ_TITLE,
  READ_URL,
  STOP_LOADING,
  hoverScript,
  keyCommandScript,
  keyWatchScript,
  readable,
  selectScript,
  setCheckedScript,
} from "./page-scripts.ts";
import type { KeyModifier } from "./daemon/protocol.ts";

export interface BrowserOptions {
  /** Persistent profile directory (`open --persistent`); ephemeral without. */
  profile?: string;
}

// bun-types (1.4.2) declares back()/forward(); the object has goBack() and
// goForward() instead, and back/forward are undefined (measured, Bun 1.4.2).
// Declared here so openBrowser can pass the real view as a ViewLike.
declare module "bun" {
  interface WebView {
    goBack(): Promise<void>;
    goForward(): Promise<void>;
  }
}

/** The slice of Bun.WebView that Browser uses. */
export interface ViewLike {
  readonly url: string;
  readonly title: string;
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, options?: { modifiers: KeyModifier[] }): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  screenshot(): Promise<Blob>;
  reload(): Promise<void>;
  close(): void;
  /** True while a navigation is in flight. */
  readonly loading: boolean;
  onNavigated: ((url: string, title: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  /** Runtime names. @types/bun declares back()/forward() instead; those do
   *  not exist on the object. Do not "fix" these to match the types. */
  goBack(): Promise<void>;
  goForward(): Promise<void>;
}

/** Resolve the page URL from the page's own location.href. WebKit's
 *  `view.url` keeps the old URL after a same-document change (pushState,
 *  replaceState, a hash change) and is "" before the first navigation; in
 *  every other case the two agree (measured, Bun 1.4.2). `view.url` is the
 *  fallback when the page cannot answer. */
export async function resolveUrl(viewUrl: string, evalHref: () => Promise<unknown>): Promise<string> {
  try {
    const loc = await evalHref();
    return typeof loc === "string" && loc ? loc : viewUrl;
  } catch {
    return viewUrl;
  }
}

/** Resolve the page title. On WebKit `view.title` is still "" when
 *  navigate() resolves even though document.title is set. When the native
 *  getter is empty, read it from the page. */
export async function resolveTitle(viewTitle: string, evalTitle: () => Promise<unknown>): Promise<string> {
  if (viewTitle) return viewTitle;
  try {
    const t = await evalTitle();
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

/** `acting`: the action was sent and has not returned. `delivered`: it
 *  returned, and the watch has seen no navigation it started yet. */
export type ActPhase = "idle" | "acting" | "delivered" | "awaiting-navigation";

export interface Browser {
  realUrl(): Promise<string>;
  realTitle(): Promise<string>;
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  /** Bun's selector click: waits up to `timeoutMs` (Bun's default, 30 s,
   *  when absent) for the element to be the topmost at its centre. */
  click(selector: string, timeoutMs?: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, modifiers?: KeyModifier[]): Promise<void>;
  hover(selector: string): Promise<void>;
  /** False when no option's value or label is `value`; nothing changed. */
  select(selector: string, value: string): Promise<boolean>;
  /** false: `uncheck` of a checked radio, refused in the page (F20). */
  setChecked(selector: string, checked: boolean): Promise<boolean>;
  screenshot(): Promise<string>; // base64-encoded PNG of the viewport
  resize(width: number, height: number): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  /** Try to free the view from a call that overran its budget: reload a
   *  committed page or leave the initial document (by script, or by
   *  navigate("about:blank") when an evaluate is stuck there). A refused
   *  reload falls back to a script reload. Waits up to settleMs for a
   *  landing, and resolves true only when the view is free: a successful
   *  landing or a second one (the first is the cancelled navigation's
   *  failure), or the initial document left. */
  interrupt(): Promise<boolean>;
  /** Call `on` when a navigation starts and again when it lands. The daemon
   *  uses it to drop the page's one-shot dialog answer. One listener; a
   *  second call replaces the first. */
  watchNavigation(on: () => void): void;
  /** Whether the oven-sh/bun#44134 workaround opened its second view. */
  readonly kickerOpened: boolean;
  readonly phase: ActPhase;
  /** Cancel an action that has not yet been sent to the page. */
  cancelAction?(): void;
  /** Clear cancellation before the next serialized request starts. */
  resetActionCancellation?(): void;
  /** True while a page navigation an action started is still unanswered
   *  after the action returned: on WebKit a selector click started then
   *  never resolves (ET-10, #78). `view.loading` stays false meanwhile. */
  readonly navigationPending: boolean;
  /** Where the page's last navigation goes; the view's url when the page
   *  cannot say. */
  navigationDestination(maxWaitMs?: number): Promise<string>;
}

/** Open a WebKit Bun.WebView. Bun throws off macOS; the CLI refuses to
 *  spawn a daemon there first (connectOrSpawn). */
export async function openBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  let view: Bun.WebView;
  try {
    view = new Bun.WebView({
      backend: "webkit",
      width: 1280,
      height: 800,
      ...(opts.profile ? { dataStore: { directory: opts.profile } } : {}),
    });
  } catch (err) {
    if (!opts.profile) throw err;
    // WebKit before macOS 15.2 has no persistent store.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--persistent: the browser refused profile ${opts.profile}: ${msg}`);
  }
  // The real Bun.WebView satisfies ViewLike structurally; no cast needed here.
  // Every evaluate on the real view refuses a page that replaced
  // JSON.stringify: WebKit returns values through it (see readable()).
  const rawEvaluate = view.evaluate.bind(view);
  view.evaluate = (expr: string) => rawEvaluate(readable(expr));
  return wrapView(view, NAV_TIMING, opts.profile, STORAGE_COMMIT_WAIT_MS, { open: openKicker });
}

// ---------------------------------------------------------------------------
// Workaround for oven-sh/bun#44134 (bowser #63). Remove this block, the
// `stalls` argument openBrowser passes and wrapView's `guard` calls once Bun
// is fixed.
//
// Bun 1.4.2's WebView host writes each reply frame with one writev on a Unix
// socket whose send buffer is 8192 bytes. When a frame is larger, the host
// queues the rest for the socket's write callback, and sometimes that tail
// goes out only when the host receives its next message from Bun. Measured
// under load (8 CPU burners), 17.5 KB data: URL: `goto` waited out its op
// budget in 30 of 300. What stalled was the navigation's NavEvent and NavDone
// frames (both carry the URL, so onNavigated stalled too), and once in 1800
// the `location.href` evaluate that `state` runs next. Long evaluate results
// alone never stalled (1000 at 17.5 KB, 600 26 KB snapshots); a screenshot's
// frame is small, its bytes go through shared memory. One message sent just
// after navigate() did not help: the stall starts when the page lands.
//
// So when a call on the view has been pending for STALL_MS, the host gets a
// message every KICK_MS until nothing is pending. It can't come through the
// main view: each of its reply slots (navigate, evaluate, screenshot, input)
// takes one call at a time, and bowser's own calls hold them. The messages go
// to a second 1x1 view that nothing else uses. It costs one more WebContent
// process (~25 MB), so it is opened on the first call that stays pending
// STALL_MS, not before, and kept for the session. Measured under load: a
// fresh one released every stuck navigate 54-90 ms after it was opened (20 of
// 20), while long-URL navigations that did not stall took 116 ms at most and
// a new view's first navigate 348 ms at most. A slow server opens it too.
// A kick's own reply could queue behind a tail that stalls again, leaving its
// slot busy; the next tick then sends a same-size resize, which uses another
// slot. That was never seen (in 1000 navigations no kick took over 74 ms),
// but without it one such stall would wait out the op budget.
// ---------------------------------------------------------------------------

/** What the kicker needs: two calls on separate reply slots. */
interface Kicker {
  evaluate(expr: string): Promise<unknown>;
  resize(width: number, height: number): Promise<void>;
  close?(): void;
}
/** How wrapView gets a kicker: `open` is called at most once, when a call
 *  has been pending `afterMs` (default STALL_MS). */
export interface StallKick {
  open: () => Kicker;
  afterMs?: number;
}
const KICKER_SIZE = 1;
const KICK_MS = 100;
const STALL_MS = 1000;

function openKicker(): Kicker {
  return new Bun.WebView({ backend: "webkit", width: KICKER_SIZE, height: KICKER_SIZE });
}

/** `guard(p)` answers what `p` answered. Once guarded calls have been pending
 *  for afterMs without a break, it opens the kicker and kicks the host every
 *  KICK_MS until none is pending. Without `stalls` it is the identity. */
function stallGuard(stalls: StallKick | undefined, clock: Clock) {
  const afterMs = stalls?.afterMs ?? STALL_MS;
  let kicker: Kicker | undefined;
  let pending = 0;
  let since = 0;
  let timer: unknown;
  let evaluating = false;
  let resizing = false;
  const kick = () => {
    if (!kicker) {
      if (!stalls || clock.now() - since < afterMs) return;
      try {
        kicker = stalls.open();
      } catch {
        return;
      }
    }
    if (!evaluating) {
      evaluating = true;
      kicker
        .evaluate(NO_OP)
        .catch(() => {})
        .finally(() => {
          evaluating = false;
        });
    } else if (!resizing) {
      resizing = true;
      kicker
        .resize(KICKER_SIZE, KICKER_SIZE)
        .catch(() => {})
        .finally(() => {
          resizing = false;
        });
    }
  };
  const tick = () => {
    kick();
    timer = clock.setTimeout(tick, KICK_MS);
  };
  return {
    guard<T>(p: Promise<T>): Promise<T> {
      if (!stalls) return p;
      if (pending++ === 0) {
        since = clock.now();
        timer = clock.setTimeout(tick, KICK_MS);
      }
      return p.finally(() => {
        if (--pending === 0) clock.clearTimeout(timer);
      });
    },
    get opened() {
      return kicker !== undefined;
    },
    close() {
      clock.clearTimeout(timer);
      kicker?.close?.();
    },
  };
}

/** How long the navigation watch waits. Exported so tests can shorten it. */
export interface NavTiming {
  /** Window after an action in which a navigation may still begin. */
  graceMs: number;
  /** Cap on waiting for a navigation that did begin. */
  settleMs: number;
  /** Between the load cap's reads (default LOAD_POLL_MS). */
  loadPollMs?: number;
}
const NAV_TIMING: NavTiming = { graceMs: 100, settleMs: 10_000 };
/** How long navigate() waits for `load` once the new document is parsed (ET-52). */
const LOAD_CAP_MS = 5000;
const LOAD_POLL_MS = 100;
const LOAD_READ_MS = 1000;
/** A new view's first evaluate waits for WebKit's web process: past 1 s in CI run 40834466493. */
const BASELINE_READ_MS = 3000;
interface LoadWatch {
  over: boolean;
  read?: Promise<unknown>;
}

/** What wrapView reads the time from and waits on. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** How long `close` waits, after leaving a persistent profile's page, for
 *  WebKit to commit localStorage: twice its 500 ms transaction window. */
const STORAGE_COMMIT_WAIT_MS = 1000;

/** Bun turns a bare named key into a WebKit editing command that fires no
 *  keydown (F11, #168), so its macOS character goes as a raw key event. With a
 *  modifier the named key fires its keydown; only Tab is swapped then. */
const RAW_KEYS: Record<string, string> = {
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
  Delete: "\uF728",
  ArrowUp: "\uF700",
  ArrowDown: "\uF701",
  ArrowLeft: "\uF702",
  ArrowRight: "\uF703",
};
function pressKey(key: string, modifiers: KeyModifier[]): string {
  return key === "Tab" || modifiers.length === 0 ? (RAW_KEYS[key] ?? key) : key;
}

/** The editing command macOS runs for a menu shortcut, which Bun.WebView
 *  delivers as a bare key event (#55; Playwright's macEditingCommands has
 *  the same three). The modifiers must match exactly: Shift+Meta+a is not
 *  select-all. Meta+C/X/V are left alone: a page script cannot reach the
 *  clipboard (execCommand("copy") answers false). */
function menuCommand(key: string, modifiers: KeyModifier[]): "selectAll" | "undo" | "redo" | undefined {
  const mods = [...modifiers].sort().join("+");
  const k = key.toLowerCase();
  if (mods === "Meta" && k === "a") return "selectAll";
  if (mods === "Meta" && k === "z") return "undo";
  if (mods === "Meta+Shift" && k === "z") return "redo";
  return undefined;
}

/** Bun.WebView resolves click()/press()/goBack() when the input is delivered,
 *  ~30 ms before the page it triggers commits (measured on WebKit, local
 *  pages). `state` right after `click` therefore reported the old URL. The
 *  watch counts navigation events and lets an action wait for the one it
 *  started: a navigation that begins within graceMs is awaited up to
 *  settleMs; an action that navigates nowhere costs the full grace window.
 *  `onNavigation` hears a navigation an action started, and every landing.
 *
 *  "Begins" is seen three ways: a landing inside the window, `view.loading`
 *  turning true, or the page's own navigate event (NAV_ARM/NAV_COUNT).
 *  The page's event is the one that shows a navigation the page starts to a
 *  slow server: on WebKit `view.loading` stays false for those and
 *  onNavigated waits for the response (measured, Bun 1.4.2: a link to a
 *  page served after 3 s showed nothing for 3 s; the navigate event fired
 *  6 ms after click() resolved). */
function navigationWatch(view: ViewLike, timing: NavTiming, onNavigation: () => void, evaluate: (expr: string) => Promise<unknown>, clock: Clock) {
  // One watch per view: this takes over the view's navigation callbacks, so
  // wrapView must be called once per view (openBrowser does).
  // A failed navigation ends the wait but does not fail the action (reload's
  // own failure does, see act): WebKit
  // reports NSURLErrorDomain -999 for routine cancellations (a page script
  // navigating right after a click), and `state` reads the real URL anyway.
  // Surfacing the last navigation error is future DaemonState work.
  // `landed` counts both outcomes; `arrived` only the successes, so a wait
  // can tell a failure that another navigation replaced (below).
  let landed = 0;
  let arrived = 0;
  let failure: Error | undefined;
  view.onNavigated = () => {
    landed++;
    arrived++;
    evaluate(MUTE_MEDIA).catch(() => {});
    onNavigation();
  };
  view.onNavigationFailed = (error) => {
    landed++;
    failure = error;
    if (phase === "idle" && pendingAt === landed - 1) void replaced();
  };
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      clock.setTimeout(r, ms);
    });
  /** Evaluate a watch script, waiting at most `ms`: a page that cannot
   *  answer in time, or at all, reads as "no". Every page read in `act` goes
   *  through here, so none can hold it past its deadline. Only the waiting
   *  stops: the evaluate stays in wrapView's queue, and the next one waits
   *  for it rather than failing. */
  const ask = async (expr: string, ms: number): Promise<unknown> => {
    if (!(ms > 0)) return undefined;
    let timer: unknown;
    try {
      return await Promise.race([
        evaluate(expr),
        new Promise<undefined>((r) => {
          timer = clock.setTimeout(() => r(undefined), ms);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clock.clearTimeout(timer);
    }
  };
  /** How many cross-document navigations the page started since NAV_ARM;
   *  0 when it cannot say within `ms`. */
  const count = async (ms: number): Promise<number> => {
    const n = await ask(NAV_COUNT, ms);
    return typeof n === "number" ? n : 0;
  };
  /** Wait for the landing a recovery reload causes, up to settleMs: a
   *  success, or a second landing after the -999 of the navigation it
   *  cancelled. */
  const freed = async (before: number, arrivedBefore: number): Promise<boolean> => {
    const began = clock.now();
    while (clock.now() - began < timing.settleMs) {
      if (arrived !== arrivedBefore || landed - before >= 2) return true;
      await sleep(10);
    }
    return false;
  };
  /** Wait for a landing after `before`, while `still()` holds, up to settleMs. */
  const settle = async (before: number, still: () => boolean): Promise<void> => {
    const began = clock.now();
    while (landed === before && still() && clock.now() - began < timing.settleMs) await sleep(10);
  };
  /** After an action: wait for a navigation that begins within graceMs to
   *  land, up to settleMs. `before` and `wasLoading` are read before it. */
  const awaitNavigation = async (before: number, wasLoading: boolean): Promise<void> => {
    const start = clock.now();
    while (clock.now() - start < timing.graceMs) {
      if (landed !== before) return;
      if (view.loading && !wasLoading) {
        phase = "awaiting-navigation";
        onNavigation();
        return settle(before, () => view.loading);
      }
      await sleep(10);
    }
    // One read at the end of the window, not a poll: each read is an
    // evaluate, and fewer of them means fewer chances to race the commit.
    if (landed !== before) return;
    // A page busy right after the action answers late, not "no navigation" (#170).
    if ((await count(timing.settleMs)) < 1) return;
    await follow(timing.settleMs);
  };
  /** Whether more navigations started since NAV_ARM than landed since:
   *  `started` is the page's count, plus the action's own for a reload. */
  const unfinished = (started: number): boolean => started > landed - armedAt;
  /** Wait up to `capMs` for the pending navigation to land. */
  const follow = async (capMs: number): Promise<void> => {
    phase = "awaiting-navigation";
    onNavigation();
    pendingAt = landed;
    // A failure ends the wait unless the page started another navigation
    // since: a script navigating again cancels the first with -999 while
    // the second still loads, and that second one is what the action led to.
    const began = clock.now();
    let base = landed;
    const baseArrived = arrived;
    while (clock.now() - began < capMs) {
      if (arrived !== baseArrived) return;
      if (landed !== base) {
        // setTimeout treats Infinity as 1 ms.
        const at = landed;
        const now = await count(Math.min(began + capMs - clock.now(), timing.settleMs));
        // A landing during the read makes the count stale against it: read again.
        if (landed !== at) continue;
        if (!unfinished(now)) return;
        base = landed;
        pendingAt = landed;
      }
      await sleep(10);
    }
  };
  /** The pending navigation failed after the watch ended: it stays pending
   *  while the page is asked whether a script started another (#98). */
  const replaced = async (): Promise<void> => {
    const base = landed;
    pendingAt = base;
    const now = await count(timing.settleMs);
    if (landed !== base) return;
    if (!unfinished(now)) pendingAt = undefined;
  };
  /** True LOAD_CAP_MS after a navigation's new document is parsed: a
   *  subresource that never finishes would hold `load` for good (ET-52).
   *  One read at a time, so a page that does not answer queues no more. */
  const capLoad = async (origin: unknown, load: LoadWatch): Promise<boolean> => {
    let doc: unknown;
    let since = 0;
    while (!load.over) {
      load.read = evaluate(LOAD_STATE).catch(() => undefined);
      const read = await load.read;
      if (load.over) return false;
      if (Array.isArray(read) && read[0] !== origin && read[1] !== "loading") {
        if (read[0] !== doc) {
          doc = read[0];
          since = clock.now();
          // A capped load never reaches onNavigated, which mutes the rest (#227).
          load.read = evaluate(MUTE_MEDIA).catch(() => undefined);
          await load.read;
          if (load.over) return false;
        } else if (clock.now() - since >= LOAD_CAP_MS) return true;
      }
      await sleep(timing.loadPollMs ?? LOAD_POLL_MS);
    }
    return false;
  };
  /** Whether navigate() landed on its own page (ET-13): WebKit answers it
   *  with whichever navigation ends first, and a script on the page left can
   *  replace it. Only a page that script sent has `leaving` as referrer, and
   *  only a replacement keeps `leftKey`, the history entry of the page left,
   *  however often it moves on. A page that cannot answer in time counts as ours. */
  const ownLanding = async (url: string, leaving: string, leftKey: unknown, load: LoadWatch): Promise<boolean> => {
    const at = landed;
    for (let waited = false; ; waited = true) {
      const seen = landed;
      let read = await ask(LANDED_PAGE, timing.graceMs);
      // A page still navigating fails the read, before or after it lands (ET-13 in CI); a redirect only costs a second read.
      if (!Array.isArray(read) && !load.over && (landed !== seen || !sameUrl(view.url, url))) read = await ask(LANDED_PAGE, timing.graceMs);
      if (load.over || !Array.isArray(read)) return true;
      const [href, referrer, key] = read;
      if (typeof referrer !== "string" || !referrer || sameUrl(href, url)) return true;
      // A navigate() to the URL already shown replaces the entry too (measured, Bun 1.4.4).
      const kept = typeof key === "string" && key === leftKey && !sameUrl(leaving, url);
      if (!sameUrl(referrer, leaving) && !kept) return true;
      // The landing can name our URL while the old page is still there; ours lands next.
      if (waited || !sameUrl(view.url, url)) return false;
      await settle(at, () => !load.over);
    }
  };
  let loadWatch: LoadWatch | undefined;
  let loadLeft = false;
  /** Stop the load a capped navigate left running, and wait for its -999 to
   *  land: otherwise it lands inside the next command's own wait (ET-52). */
  const stopLoadLeft = async (): Promise<void> => {
    if (!loadLeft) return;
    loadLeft = false;
    if (!view.loading) return;
    const before = landed;
    await ask(STOP_LOADING, timing.graceMs);
    await settle(before, () => true);
  };
  let phase: ActPhase = "idle";
  let actionCancelled = false;
  let pendingAt: number | undefined;
  // A reload is a navigation the page's count never sees (#116), so its own landing is not counted.
  let armedAt = 0;
  return {
    get phase() {
      return phase;
    },
    cancelAction() {
      actionCancelled = true;
    },
    resetActionCancellation() {
      actionCancelled = false;
    },
    get pending() {
      return pendingAt === landed;
    },
    async destination(maxWaitMs = timing.graceMs): Promise<string> {
      const url = await ask(NAV_DESTINATION, maxWaitMs);
      return typeof url === "string" && url ? url : view.url;
    },
    /** Run `action` and wait for a navigation it started; see above.
     *  Answers what the action answered. An action that always `navigates`
     *  waits for its landing with no grace or settle cap, and fails with
     *  that landing's failure unless it is a -999, as navigate does (#123).
     *  A `history` action waits as a click does, and fails the same way when
     *  the page it goes to fails to load (#127). */
    async act<T>(action: () => Promise<T>, kind: "acts" | "navigates" | "history" = "acts"): Promise<T> {
      try {
        await stopLoadLeft();
        const before = landed;
        // A navigation already in flight is not ours: only a false→true transition
        // of `loading` counts, or one stuck navigation would cost every later
        // action the full settleMs. The page flag is cleared for the same reason.
        const wasLoading = view.loading;
        await ask(NAV_ARM, timing.graceMs);
        if (actionCancelled) throw new Error("request timed out before the action was sent");
        const landedBefore = landed;
        const arrivedBefore = arrived;
        armedAt = kind === "navigates" ? landed + 1 : landed;
        phase = "acting";
        const result = await action();
        phase = "delivered";
        // A -999 here is the navigation the reload cancelled; any other
        // failure is the reload's own (measured, Bun 1.4.2).
        const ended = arrived !== arrivedBefore || (landed !== landedBefore && !cancelled(failure));
        if (kind !== "navigates") await awaitNavigation(before, wasLoading);
        else if (!ended) await follow(Infinity);
        if (kind !== "acts" && arrived === arrivedBefore && landed !== landedBefore && failure && !cancelled(failure)) throw failure;
        return result;
      } finally {
        phase = "idle";
      }
    },
    /** Run `go`, a navigate(). WebKit answers it with the first landing
     *  after it: when it cancels a navigation still loading (a reload's, a
     *  page script's), that one's -999 rejects it while its own still loads
     *  (#116, measured on Bun 1.4.2). Then this waits for the next landing. */
    async navigate(url: string, go: () => Promise<void>): Promise<void> {
      await stopLoadLeft();
      const before = landed;
      const arrivedBefore = arrived;
      const origin = await ask(DOC_ID, BASELINE_READ_MS);
      const leftKey = await ask(ENTRY_KEY, timing.graceMs);
      // The baseline read can outlast the budget: the command has been told it failed.
      if (actionCancelled) throw new Error("request timed out before the navigation was sent");
      const load: LoadWatch = { over: false };
      loadWatch = load;
      const replacedBy = () =>
        new Error(`navigate: the navigation to ${url} was cancelled by another navigation; run 'bowser snapshot' to see where the page is`);
      const loaded = (async () => {
        const leaving = view.url;
        try {
          await go();
        } catch (err) {
          if (!interrupted(err)) throw err;
          while (landed - before < 2 && !load.over) await sleep(10);
          if (load.over) return;
          if (arrived === arrivedBefore) {
            if (failure && !interrupted(failure)) throw failure;
            throw replacedBy();
          }
        }
        if (!(await ownLanding(url, leaving, leftKey, load))) throw replacedBy();
      })();
      const racers = [loaded];
      if (origin !== undefined)
        racers.push(
          // A watcher ended by interrupt() must not finish navigate: go() is still pending.
          capLoad(origin, load).then((capped) => {
            if (!capped) return new Promise<void>(() => {});
            loadLeft = true;
          }),
        );
      try {
        await Promise.race(racers);
      } finally {
        load.over = true;
        loaded.catch(() => {});
      }
    },
    stopLoadLeft,
    /** Reload the committed page, or leave the initial document, to free a
     *  stuck call; see Browser.interrupt. */
    async interrupt(): Promise<boolean> {
      // WebKit refuses the evaluates below while the load cap's read is pending.
      if (loadWatch && !loadWatch.over) {
        loadWatch.over = true;
        let timer: unknown;
        await Promise.race([
          loadWatch.read,
          new Promise<void>((r) => {
            timer = clock.setTimeout(r, LOAD_READ_MS);
          }),
        ]);
        clock.clearTimeout(timer);
      }
      const before = landed;
      const arrivedBefore = arrived;
      if (view.url === "") {
        // Nothing has committed yet: a first navigation from the initial
        // document is stuck. reload() has no page to reload and does
        // nothing, and navigate() is refused while one is pending
        // (measured, Bun 1.4.2). The initial document still runs a
        // script, and leaving it cancels the navigation with -999 (#48).
        // The call goes to the view, not wrapView's queue: if an evaluate
        // is pending WebKit refuses this one at once, where the queue
        // would run it later over whatever page is there then.
        let timer: unknown;
        const leave = Promise.resolve()
          .then(() => view.evaluate(LEAVE_INITIAL_DOCUMENT))
          .then(
            () => true,
            () => false,
          );
        const leaveBound = new Promise<false>((r) => {
          timer = clock.setTimeout(() => r(false), timing.settleMs);
        });
        const left = await Promise.race([leave, leaveBound]);
        clock.clearTimeout(timer);
        if (left) {
          await settle(before, () => true);
          return landed !== before;
        } else {
          // Refused: an evaluate is stuck, not a navigation (#67). With no
          // navigation pending navigate() is accepted, and it frees the
          // stuck evaluate ~3.2 s later (measured on a bare WebView). Its
          // own resolution is the landing, so there is no settle after it.
          // Awaited up to settleMs; one that never settles is left to
          // WebKit and the lane moves on (the next op may then be refused).
          const navigate = view.navigate("about:blank").then(
            () => true,
            () => false,
          );
          timer = undefined;
          const bound = new Promise<boolean>((r) => {
            timer = clock.setTimeout(() => r(false), timing.settleMs);
          });
          const ok = await Promise.race([navigate, bound]);
          clock.clearTimeout(timer);
          return ok;
        }
      }
      let timer: unknown;
      const reloadAttempt = Promise.resolve()
        .then(() => view.reload())
        .then(
          () => "ok" as const,
          () => "failed" as const,
        );
      const reloadBound = new Promise<"timeout">((r) => {
        timer = clock.setTimeout(() => r("timeout"), timing.settleMs);
      });
      const reloadResult = await Promise.race([reloadAttempt, reloadBound]);
      clock.clearTimeout(timer);
      if (reloadResult === "timeout") return false;
      if (reloadResult === "failed") {
        // Refused while a selector click is hung on a pending page
        // navigation (#78); a script reload still cancels it. Straight to
        // the view, as above: wrapView's queue may be held by that page.
        const sent = view.evaluate(CANCEL_PENDING_NAVIGATION).then(
          () => true,
          () => false,
        );
        timer = undefined;
        const bound = new Promise<boolean>((r) => {
          timer = clock.setTimeout(() => r(false), timing.settleMs);
        });
        const ok = await Promise.race([sent, bound]);
        clock.clearTimeout(timer);
        if (!ok) return false;
      }
      return freed(before, arrivedBefore);
    },
  };
}

/** Turn a view into a Browser. Separate from openBrowser so tests can pass a
 *  fake view; openBrowser is the only caller with a real one. `profile` is
 *  the persistent store's directory, if the view has one. */
export function wrapView(
  view: ViewLike,
  timing: NavTiming = NAV_TIMING,
  profile?: string,
  commitWaitMs = STORAGE_COMMIT_WAIT_MS,
  stalls?: StallKick,
  clock: Clock = REAL_CLOCK,
): Browser {
  let navigated: () => void = () => {};
  const stall = stallGuard(stalls, clock);
  const { guard } = stall;
  // One evaluate at a time per view: WebKit throws ERR_INVALID_STATE for a
  // second while one is pending. The daemon's serializer runs one op at a
  // time, but inside an op the watch may stop waiting for a slow page read
  // (ask's bound) while WebKit still runs it. So every evaluate waits for
  // the previous one to settle, whether it resolved or failed. A page that
  // never answers holds the queue until the op's budget runs out, and the
  // recovery reload (which never evaluates) frees it.
  let inflight: Promise<unknown> = Promise.resolve();
  const evaluate = (expr: string): Promise<unknown> => {
    const run = inflight.then(() => guard(view.evaluate(expr)));
    inflight = run.catch(() => {});
    return run;
  };
  const nav = navigationWatch(view, timing, () => navigated(), evaluate, clock);

  return {
    get phase() {
      return nav.phase;
    },
    cancelAction: () => nav.cancelAction(),
    resetActionCancellation: () => nav.resetActionCancellation(),
    get navigationPending() {
      return nav.pending;
    },
    navigationDestination: (maxWaitMs) => nav.destination(maxWaitMs),
    realUrl: () => resolveUrl(view.url, () => evaluate(READ_URL)),
    realTitle: () => resolveTitle(view.title, () => evaluate(READ_TITLE)),
    navigate: (url) => guard(nav.navigate(url, () => view.navigate(url))),
    evaluate: (expr) => evaluate(expr),
    click: (selector, timeoutMs) => guard(nav.act(() => view.click(selector, timeoutMs === undefined ? undefined : { timeout: timeoutMs }))),
    type: (text) => guard(nav.act(() => view.type(text))),
    press: (key, modifiers = []) =>
      guard(
        nav.act(async () => {
          const command = menuCommand(key, modifiers);
          if (command) await evaluate(keyWatchScript(key));
          const sent = pressKey(key, modifiers);
          if (sent !== key) await evaluate(KEY_CODES);
          await view.press(sent, modifiers.length ? { modifiers } : undefined);
          if (command) await evaluate(keyCommandScript(command));
        }),
      ),
    // A page's change or mouse handler can navigate, so the page-script
    // actions go through the watch too (#51: a select whose onchange set
    // location.href left the next snapshot on the old page).
    hover: (selector) =>
      guard(
        nav.act(async () => {
          await evaluate(hoverScript(selector));
        }),
      ),
    select: (selector, value) => guard(nav.act(async () => (await evaluate(selectScript(selector, value))) === true)),
    setChecked: (selector, checked) => guard(nav.act(async () => (await evaluate(setCheckedScript(selector, checked))) !== false)),
    screenshot: async () => {
      // Bun.WebView.screenshot() returns a Blob (image/png) of the viewport; it
      // takes no full-page option. Element-bounded screenshots are not supported.
      const bytes = new Uint8Array(await (await guard(view.screenshot())).arrayBuffer());
      if (!isLikelyPng(bytes)) {
        throw new Error("screenshot: WebView returned an empty/invalid image");
      }
      return Buffer.from(bytes).toString("base64");
    },
    resize: (width, height) => guard(view.resize(width, height)),
    back: () => guard(nav.act(() => view.goBack(), "history")),
    forward: () => guard(nav.act(() => view.goForward(), "history")),
    // Native reload() resolves before the reload commits, and nothing shows
    // the reload until it lands: view.loading stays false and the page sees
    // no navigate event (#116, measured on Bun 1.4.2). So its landing is
    // always awaited, except where nothing has committed and reload() does
    // nothing.
    reload: () => guard(nav.act(() => view.reload(), view.url !== "" ? "navigates" : "acts")),
    close: async () => {
      // WebKit commits localStorage in a transaction 500 ms after a write
      // (measured ~530 ms, also with the CPU saturated), and Bun force-kills
      // the browser when the daemon exits right after this. A write in the
      // last half second before `close` was lost (#61: 2 in 10 e2e runs
      // under load). Leaving the page for about:blank stops new writes; it
      // does not commit anything by itself, so close then waits out the
      // window before closing the view.
      if (profile) {
        try {
          await nav.stopLoadLeft();
          await guard(view.navigate("about:blank"));
        } catch {}
        await Bun.sleep(commitWaitMs);
      }
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      view.close();
      stall.close();
    },
    // Measured on WebKit (Bun 1.4.2): a native reload() frees an evaluate
    // stuck on a promise that never settles (it rejects "no longer
    // reachable" ~2.4 s later; cookies kept, same URL) and cancels a
    // navigation whose server never answers (-999 at once). A page stuck in
    // a synchronous loop is freed by nothing short of closing the view.
    // This is called while the stuck call is still pending, so it overlaps
    // that call by design, and nothing else that touches the view: the
    // daemon's serializer holds every other queued op until the stuck one
    // settles and this has landed. That is why it uses the native reload()
    // and never wrapView's evaluate(): an evaluate would queue behind the
    // stuck one and never run. The one
    // exception is a view where nothing has committed, where reload() does
    // nothing: it asks the view directly, which WebKit refuses at once
    // while another evaluate is pending (#48).
    interrupt: () => guard(nav.interrupt()),
    get kickerOpened() {
      return stall.opened;
    },
    watchNavigation(on) {
      navigated = on;
    },
  };
}

/** WebKit's failure for a navigation it cancelled. */
function cancelled(err: unknown): boolean {
  return err instanceof Error && err.message.includes("NSURLErrorDomain error -999");
}

/** cancelled, or WebKit's other answer when a page script's navigation replaces navigate()'s (ET-13, Bun 1.4.4). */
function interrupted(err: unknown): boolean {
  return cancelled(err) || (err instanceof Error && err.message === "Frame load interrupted");
}

/** The same page: origin, path without a trailing slash, and query, with equivalent escapes decoded; the fragment is ignored. */
function sameUrl(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const decoded = (s: string) => {
      try {
        return decodeURI(s);
      } catch {
        return s;
      }
    };
    const path = (u: URL) => decoded(u.pathname).replace(/\/$/, "");
    return x.origin === y.origin && path(x) === path(y) && decoded(x.search) === decoded(y.search);
  } catch {
    return a === b;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Cheap sanity check that `bytes` is a real PNG: the 8-byte signature plus a
 *  plausible minimum length (a 1x1 PNG is ~67 bytes; the broken capture writes
 *  only a few bytes). Used to fail loud instead of saving a broken screenshot. */
export function isLikelyPng(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return false; // 8-byte sig + 25-byte IHDR chunk floor
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
