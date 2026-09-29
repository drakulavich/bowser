// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView, always with the native WebKit backend (macOS).

import {
  KEY_WATCH, LEAVE_INITIAL_DOCUMENT, NAV_ARM, NAV_COUNT, NO_OP, READ_TITLE, READ_URL, RELOAD,
  hoverScript, keyCommandScript, readable, selectScript, setCheckedScript,
} from "./page-scripts.ts";
import type { KeyModifier } from "./daemon/protocol.ts";

export interface BrowserOptions {
  width?: number;
  height?: number;
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

/** The slice of Bun.WebView that Browser uses. Optional members are the ones
 *  a Bun build may lack; wrapView probes them with typeof. */
export interface ViewLike {
  readonly url: string;
  readonly title: string;
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, options?: { modifiers: KeyModifier[] }): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  screenshot?(): Promise<Blob | string>;
  reload?(): Promise<void>;
  close?(): void;
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
export async function resolveUrl(
  viewUrl: string,
  evalHref: () => Promise<unknown>,
): Promise<string> {
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
export async function resolveTitle(
  viewTitle: string,
  evalTitle: () => Promise<unknown>,
): Promise<string> {
  if (viewTitle) return viewTitle;
  try {
    const t = await evalTitle();
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

export interface Browser {
  url: string;
  title: string;
  realUrl(): Promise<string>;
  realTitle(): Promise<string>;
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  click(selector: string): Promise<void>;
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
   *  navigate("about:blank") when an evaluate is stuck there). Waits for the
   *  native call to settle (the fallback up to settleMs), then for a landing
   *  up to settleMs. */
  interrupt(): Promise<void>;
  /** Call `on` when a navigation starts and again when it lands. The daemon
   *  uses it to drop the page's one-shot dialog answer. One listener; a
   *  second call replaces the first. */
  watchNavigation(on: () => void): void;
  /** Whether the oven-sh/bun#44134 workaround opened its second view. */
  readonly kickerOpened: boolean;
}

/** Open a WebKit Bun.WebView. Bun throws off macOS; the CLI refuses to
 *  spawn a daemon there first (connectOrSpawn). */
export async function openBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  let view: Bun.WebView;
  try {
    view = new Bun.WebView({
      backend: "webkit",
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
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
function stallGuard(stalls: StallKick | undefined) {
  const afterMs = stalls?.afterMs ?? STALL_MS;
  let kicker: Kicker | undefined;
  let pending = 0;
  let since = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let evaluating = false;
  let resizing = false;
  const kick = () => {
    if (!kicker) {
      if (!stalls || Date.now() - since < afterMs) return;
      try {
        kicker = stalls.open();
      } catch {
        return;
      }
    }
    if (!evaluating) {
      evaluating = true;
      kicker.evaluate(NO_OP).catch(() => {}).finally(() => { evaluating = false; });
    } else if (!resizing) {
      resizing = true;
      kicker.resize(KICKER_SIZE, KICKER_SIZE).catch(() => {}).finally(() => { resizing = false; });
    }
  };
  return {
    guard<T>(p: Promise<T>): Promise<T> {
      if (!stalls) return p;
      if (pending++ === 0) {
        since = Date.now();
        timer = setInterval(kick, KICK_MS);
      }
      return p.finally(() => {
        if (--pending === 0) clearInterval(timer);
      });
    },
    get opened() { return kicker !== undefined; },
    close() {
      clearInterval(timer);
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
}
const NAV_TIMING: NavTiming = { graceMs: 100, settleMs: 10_000 };

/** How long `close` waits, after leaving a persistent profile's page, for
 *  WebKit to commit localStorage: twice its 500 ms transaction window. */
const STORAGE_COMMIT_WAIT_MS = 1000;

/** The key `view.press` is given for a key name (F11). Bun maps a named key to
 *  a WebKit editing command where one exists, and "Tab" becomes "insert tab":
 *  a `\t` lands in the field and no keydown fires. The tab character is sent
 *  as a raw key event instead: focus moves as the browser's own Tab moves it,
 *  and the page sees a trusted keydown with key "Tab" (measured on WebKit,
 *  Bun 1.4.2). Every other key passes through. */
function pressKey(key: string): string {
  return key === "Tab" ? "\t" : key;
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
function navigationWatch(
  view: ViewLike,
  timing: NavTiming,
  onNavigation: () => void,
  evaluate: (expr: string) => Promise<unknown>,
) {
  // One watch per view: this takes over the view's navigation callbacks, so
  // wrapView must be called once per view (openBrowser does).
  // A failed navigation ends the wait but does not fail the action: WebKit
  // reports NSURLErrorDomain -999 for routine cancellations (a page script
  // navigating right after a click), and `state` reads the real URL anyway.
  // Surfacing the last navigation error is future DaemonState work.
  // `landed` counts both outcomes; `arrived` only the successes, so a wait
  // can tell a failure that another navigation replaced (below).
  let landed = 0;
  let arrived = 0;
  view.onNavigated = () => { landed++; arrived++; onNavigation(); };
  view.onNavigationFailed = () => { landed++; };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** Evaluate a watch script, waiting at most `ms`: a page that cannot
   *  answer in time, or at all, reads as "no". Every page read in `act` goes
   *  through here, so none can hold it past its deadline. Only the waiting
   *  stops: the evaluate stays in wrapView's queue, and the next one waits
   *  for it rather than failing. */
  const ask = async (expr: string, ms: number): Promise<unknown> => {
    if (!(ms > 0)) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        evaluate(expr),
        new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  /** How many cross-document navigations the page started since NAV_ARM;
   *  0 when it cannot say within `ms`. */
  const count = async (ms: number): Promise<number> => {
    const n = await ask(NAV_COUNT, ms);
    return typeof n === "number" ? n : 0;
  };
  /** Wait for a landing after `before`, while `still()` holds, up to settleMs. */
  const settle = async (before: number, still: () => boolean): Promise<void> => {
    const began = Date.now();
    while (landed === before && still() && Date.now() - began < timing.settleMs) await sleep(10);
  };
  /** After an action: wait for a navigation that begins within graceMs to
   *  land, up to settleMs. `before` and `wasLoading` are read before it. */
  const awaitNavigation = async (before: number, wasLoading: boolean): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timing.graceMs) {
      if (landed !== before) return;
      if (view.loading && !wasLoading) {
        onNavigation();
        return settle(before, () => view.loading);
      }
      await sleep(10);
    }
    // One read at the end of the window, not a poll: each read is an
    // evaluate, and fewer of them means fewer chances to race the commit.
    if (landed !== before) return;
    let seen = await count(timing.graceMs);
    if (seen < 1) return;
    onNavigation();
    // A failure ends the wait unless the page started another navigation
    // since: a script navigating again cancels the first with -999 while
    // the second still loads, and that second one is what the action led to.
    const began = Date.now();
    let base = landed;
    const baseArrived = arrived;
    while (Date.now() - began < timing.settleMs) {
      if (arrived !== baseArrived) return;
      if (landed !== base) {
        const now = await count(began + timing.settleMs - Date.now());
        if (now <= seen) return;
        seen = now;
        base = landed;
      }
      await sleep(10);
    }
  };
  return {
    /** Run `action` and wait for a navigation it started; see above.
     *  Answers what the action answered. */
    async act<T>(action: () => Promise<T>): Promise<T> {
      const before = landed;
      // A navigation already in flight is not ours: only a false→true transition
      // of `loading` counts, or one stuck navigation would cost every later
      // action the full settleMs. The page flag is cleared for the same reason.
      const wasLoading = view.loading;
      await ask(NAV_ARM, timing.graceMs);
      const result = await action();
      await awaitNavigation(before, wasLoading);
      return result;
    },
    /** Reload the committed page, or leave the initial document, to free a
     *  stuck call; see Browser.interrupt. */
    async interrupt(): Promise<void> {
      const before = landed;
      try {
        if (view.url === "") {
          // Nothing has committed yet: a first navigation from the initial
          // document is stuck. reload() has no page to reload and does
          // nothing, and navigate() is refused while one is pending
          // (measured, Bun 1.4.2). The initial document still runs a
          // script, and leaving it cancels the navigation with -999 (#48).
          // The call goes to the view, not wrapView's queue: if an evaluate
          // is pending WebKit refuses this one at once, where the queue
          // would run it later over whatever page is there then.
          try {
            await view.evaluate(LEAVE_INITIAL_DOCUMENT);
          } catch {
            // Refused: an evaluate is stuck, not a navigation (#67). With no
            // navigation pending navigate() is accepted, and it frees the
            // stuck evaluate ~3.2 s later (measured on a bare WebView). Its
            // own resolution is the landing, so there is no settle after it.
            // Awaited up to settleMs; one that never settles is left to
            // WebKit and the lane moves on (the next op may then be refused).
            const left = view.navigate("about:blank").catch(() => {});
            let timer: ReturnType<typeof setTimeout> | undefined;
            const bound = new Promise<void>((r) => { timer = setTimeout(r, timing.settleMs); });
            await Promise.race([left, bound]);
            clearTimeout(timer);
            return;
          }
        } else if (typeof view.reload === "function") {
          await view.reload();
        } else {
          return;
        }
      } catch {
        return;
      }
      await settle(before, () => true);
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
): Browser {
  let navigated: () => void = () => {};
  const stall = stallGuard(stalls);
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
  const nav = navigationWatch(view, timing, () => navigated(), evaluate);

  return {
    get url() { return view.url; },
    get title() { return view.title; },
    realUrl: () => resolveUrl(view.url, () => evaluate(READ_URL)),
    realTitle: () => resolveTitle(view.title, () => evaluate(READ_TITLE)),
    navigate: (url) => guard(view.navigate(url)),
    evaluate: (expr) => evaluate(expr),
    click: (selector) => guard(nav.act(() => view.click(selector))),
    type: (text) => guard(nav.act(() => view.type(text))),
    press: (key, modifiers = []) => guard(nav.act(async () => {
      const command = menuCommand(key, modifiers);
      if (command) await evaluate(KEY_WATCH);
      await view.press(pressKey(key), modifiers.length ? { modifiers } : undefined);
      if (command) await evaluate(keyCommandScript(command));
    })),
    // A page's change or mouse handler can navigate, so the page-script
    // actions go through the watch too (#51: a select whose onchange set
    // location.href left the next snapshot on the old page).
    hover: (selector) => guard(nav.act(async () => { await evaluate(hoverScript(selector)); })),
    select: (selector, value) => guard(nav.act(async () => (await evaluate(selectScript(selector, value))) === true)),
    setChecked: (selector, checked) => guard(nav.act(async () => (await evaluate(setCheckedScript(selector, checked))) !== false)),
    screenshot: async () => {
      // Bun.WebView.screenshot() returns a Blob (image/png) of the viewport; it
      // takes no full-page option. Element-bounded screenshots are not supported.
      const data = view.screenshot && (await guard(view.screenshot()));
      if (!data) throw new Error("screenshot: not supported by this Bun.WebView");
      const bytes = await pngBytesFrom(data);
      if (!isLikelyPng(bytes)) {
        throw new Error("screenshot: WebView returned an empty/invalid image");
      }
      return Buffer.from(bytes).toString("base64");
    },
    resize: (width, height) => guard(view.resize(width, height)),
    back: () => guard(nav.act(() => view.goBack())),
    forward: () => guard(nav.act(() => view.goForward())),
    reload: () => guard(nav.act(async () => {
      // Native reload() resolves before the reload commits, like goBack();
      // measured in the daemon: a navigate() 1 ms later was rejected with
      // NSURLErrorDomain -999. The watch makes reload return once it lands.
      if (typeof view.reload === "function") await view.reload();
      else await evaluate(RELOAD);
    })),
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
          await guard(view.navigate("about:blank"));
        } catch {}
        await Bun.sleep(commitWaitMs);
      }
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      view.close?.();
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
    // stuck one and never run, and so would RELOAD's fallback. The one
    // exception is a view where nothing has committed, where reload() does
    // nothing: it asks the view directly, which WebKit refuses at once
    // while another evaluate is pending (#48).
    interrupt: () => guard(nav.interrupt()),
    get kickerOpened() { return stall.opened; },
    watchNavigation(on) {
      navigated = on;
    },
  };
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

/** Decode whatever Bun.WebView.screenshot() returns into raw PNG bytes.
 *  Current Bun returns a Blob (type image/png); we also accept a base64 string
 *  defensively in case the API shape changes. */
export async function pngBytesFrom(data: Blob | string): Promise<Uint8Array> {
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
  return new Uint8Array(await data.arrayBuffer());
}
