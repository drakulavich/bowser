// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView, always with the native WebKit backend (macOS).

import {
  HISTORY_BACK, HISTORY_FORWARD, READ_TITLE, READ_URL, RELOAD,
  hoverScript, selectScript, setCheckedScript,
} from "./page-scripts.ts";

export interface BrowserOptions {
  width?: number;
  height?: number;
  /** Persistent profile directory (`open --persistent`); ephemeral without. */
  profile?: string;
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
  press(key: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  screenshot?(): Promise<Blob | string>;
  reload?(): Promise<void>;
  close?(): void;
  /** True while a navigation is in flight. */
  readonly loading: boolean;
  onNavigated: ((url: string, title: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  /** Runtime names. @types/bun (1.4.0) declares back()/forward() instead;
   *  those do not exist on the object. Do not "fix" these to match the types. */
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
}

/** Resolve the committed page URL. WebKit's `view.url` is right after every
 *  navigation (query strings and redirects included; measured, Bun 1.4.2),
 *  but it is "" before the first one, where the page is about:blank. When
 *  it is empty, read location.href from the page instead. */
export async function resolveUrl(
  viewUrl: string,
  evalHref: () => Promise<unknown>,
): Promise<string> {
  if (viewUrl) return viewUrl;
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
  press(key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  setChecked(selector: string, checked: boolean): Promise<void>;
  screenshot(): Promise<string>; // base64-encoded PNG (full page)
  resize(width: number, height: number): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  /** Call `on` when a navigation starts and again when it lands. The daemon
   *  uses it to drop the page's one-shot dialog answer. One listener; a
   *  second call replaces the first. */
  watchNavigation(on: () => void): void;
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
  return wrapView(view, NAV_TIMING, opts.profile);
}

/** How long the navigation watch waits. Exported so tests can shorten it. */
export interface NavTiming {
  /** Window after an action in which a navigation may still begin. */
  graceMs: number;
  /** Cap on waiting for a navigation that did begin. */
  settleMs: number;
}
export const NAV_TIMING: NavTiming = { graceMs: 100, settleMs: 10_000 };

/** Bun.WebView resolves click()/press()/goBack() when the input is delivered,
 *  ~30 ms before the page it triggers commits (measured on WebKit, local
 *  pages). `state` right after `click` therefore reported the old URL. The
 *  watch counts navigation events and lets an action wait for the one it
 *  started: a navigation that begins within graceMs is awaited up to
 *  settleMs; an action that navigates nowhere costs the full grace window.
 *  `onNavigation` hears a navigation an action started, and every landing. */
function navigationWatch(view: ViewLike, timing: NavTiming, onNavigation: () => void) {
  // One watch per view: this takes over the view's navigation callbacks, so
  // wrapView must be called once per view (openBrowser does).
  // A failed navigation ends the wait but does not fail the action: WebKit
  // reports NSURLErrorDomain -999 for routine cancellations (a page script
  // navigating right after a click), and `state` reads the real URL anyway.
  // Surfacing the last navigation error is future DaemonState work.
  let landed = 0;
  view.onNavigated = () => { landed++; onNavigation(); };
  view.onNavigationFailed = () => { landed++; };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    async act(action: () => Promise<void>): Promise<void> {
      const before = landed;
      // A navigation already in flight is not ours: only a false→true transition
      // of `loading` counts, or one stuck navigation would cost every later
      // action the full settleMs.
      const wasLoading = view.loading;
      await action();
      let started = false;
      const start = Date.now();
      while (Date.now() - start < timing.graceMs) {
        if (landed !== before) return;
        if (view.loading && !wasLoading) { started = true; onNavigation(); break; }
        await sleep(10);
      }
      if (!started) return;
      const began = Date.now();
      while (view.loading && landed === before && Date.now() - began < timing.settleMs) await sleep(10);
    },
  };
}

/** Turn a view into a Browser. Separate from openBrowser so tests can pass a
 *  fake view; openBrowser is the only caller with a real one. `profile` is
 *  the persistent store's directory, if the view has one. */
export function wrapView(view: ViewLike, timing: NavTiming = NAV_TIMING, profile?: string): Browser {
  let navigated: () => void = () => {};
  const nav = navigationWatch(view, timing, () => navigated());

  return {
    get url() { return view.url; },
    get title() { return view.title; },
    realUrl: () => resolveUrl(view.url, () => view.evaluate(READ_URL)),
    realTitle: () => resolveTitle(view.title, () => view.evaluate(READ_TITLE)),
    navigate: (url) => view.navigate(url),
    evaluate: (expr) => view.evaluate(expr),
    click: (selector) => nav.act(() => view.click(selector)),
    type: (text) => view.type(text),
    press: (key) => nav.act(() => view.press(key)),
    hover: async (selector) => { await view.evaluate(hoverScript(selector)); },
    select: async (selector, value) => { await view.evaluate(selectScript(selector, value)); },
    setChecked: async (selector, checked) => { await view.evaluate(setCheckedScript(selector, checked)); },
    screenshot: async () => {
      // Bun.WebView.screenshot() returns a Blob (image/png) for the full page.
      // Element-bounded screenshots are not supported in v1.
      const data = await view.screenshot?.();
      if (!data) throw new Error("screenshot: not supported by this Bun.WebView");
      const bytes = await pngBytesFrom(data);
      if (!isLikelyPng(bytes)) {
        throw new Error("screenshot: WebView returned an empty/invalid image");
      }
      return Buffer.from(bytes).toString("base64");
    },
    resize: (width, height) => view.resize(width, height),
    back: () => nav.act(async () => {
      if (typeof view.goBack === "function") await view.goBack();
      else await view.evaluate(HISTORY_BACK);
    }),
    forward: () => nav.act(async () => {
      if (typeof view.goForward === "function") await view.goForward();
      else await view.evaluate(HISTORY_FORWARD);
    }),
    reload: () => nav.act(async () => {
      // Native reload() resolves before the reload commits, like goBack();
      // measured in the daemon: a navigate() 1 ms later was rejected with
      // NSURLErrorDomain -999. The watch makes reload return once it lands.
      if (typeof view.reload === "function") await view.reload();
      else await view.evaluate(RELOAD);
    }),
    close: async () => {
      // WebKit writes a persistent profile lazily, and the daemon exits right
      // after this, so it must be made to flush first (measured: a
      // localStorage item written just before `close` was lost 14 times in
      // 15). WebKit hands a page's storage over when the page goes away;
      // leaving it for about:blank kept the item 40 times in 40.
      if (profile) {
        try {
          await view.navigate("about:blank");
        } catch {}
      }
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      view.close?.();
    },
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
