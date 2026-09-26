// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView; backend choice lives in backend.ts.

import { chromeBackend, resolveBackend, toBunBackend } from "./backend.ts";
import {
  HISTORY_BACK, HISTORY_FORWARD, READ_TITLE, READ_URL, RELOAD,
  hoverScript, selectScript, setCheckedScript,
} from "./page-scripts.ts";
import type { Backend } from "./backend.ts";
import type { DialogState } from "./daemon/protocol.ts";

/** What the daemon hears about dialogs. `navigation` fires when a
 *  navigation starts and again when it lands (a one-shot answer is lost on
 *  navigation); `opened` on chrome only. */
export interface DialogListener {
  opened(dialog: DialogState): void;
  navigation(): void;
}

export interface BrowserOptions {
  executablePath?: string;
  width?: number;
  height?: number;
  /** Persistent profile directory (`open --persistent`); ephemeral without. */
  profile?: string;
}

/** The error every CDP-only path raises on webkit. The daemon answers
 *  `requires: "cdp"` ops with it before their handler runs; `Browser.cdp()`
 *  raises it as a backstop. Tests and docs quote it: change it here only. */
export const CDP_UNAVAILABLE =
  "CDP is only available on the chrome backend (current: webkit) — " +
  "run 'bowser install' to use Chromium-backed features";

/** The slice of Bun.WebView that Browser uses. Optional members are the ones
 *  a backend or Bun build may lack; wrapView probes them with typeof. */
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
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close?(): void;
  /** True while a navigation is in flight. */
  readonly loading: boolean;
  onNavigated: ((url: string, title: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  /** Runtime names. @types/bun (1.4.0) declares back()/forward() instead;
   *  those do not exist on the object. Do not "fix" these to match the types. */
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
  /** Chrome only in practice: webkit accepts the registration and never
   *  fires. Not the same mechanism as onNavigated/onNavigationFailed above,
   *  which are assignable properties this file already owns. */
  addEventListener(event: string, handler: (e: { type: string; data?: unknown }) => void): void;
}

/** Resolve the committed page URL. Bun.WebView's `view.url` returns "about:blank"
 *  on the chrome backend even after a successful navigation to a query-string URL
 *  (the page loaded; only the getter is wrong). When `viewUrl` is blank/empty, fall
 *  back to evaluating location.href, which is correct on both backends. */
export async function resolveUrl(
  viewUrl: string,
  evalHref: () => Promise<unknown>,
): Promise<string> {
  if (viewUrl && viewUrl !== "about:blank") return viewUrl;
  try {
    const loc = await evalHref();
    return typeof loc === "string" && loc ? loc : viewUrl;
  } catch {
    return viewUrl;
  }
}

/** Resolve the page title. On the webkit backend `view.title` is still ""
 *  when navigate() resolves even though document.title is set (chrome has
 *  it ready). When the native getter is empty, read it from the page. */
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
  /** True when the chrome backend is active and view.cdp() is available. */
  cdpAvailable(): boolean;
  /** Send a raw CDP command. Chrome backend only; rejects on webkit with a
   *  clear message indicating the chrome backend is required. */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Listen for a backend event by name (CDP event names on chrome, e.g.
   *  "Page.javascriptDialogOpening"; the domain must be enabled first with
   *  cdp("Page.enable", {})). Returns false on webkit, where no such event is
   *  ever delivered — check the result rather than assuming it fired. */
  subscribe(event: string, handler: (data: unknown) => void): boolean;
  /** Report dialogs and navigations to `on`. Returns false on webkit, where
   *  only `navigation` is ever called. Call once, before the first navigate,
   *  so a dialog during the first page load is seen too: the listener needs
   *  no CDP session (measured, Bun 1.4.2: Bun enables the Page domain itself
   *  and delivers the event during the first navigate). */
  watchDialogs(on: DialogListener): boolean;
  /** Answer the open dialog (chrome: Page.handleJavaScriptDialog). */
  answerDialog(accept: boolean, promptText?: string): Promise<void>;
}

/** Open a Bun.WebView. Backend precedence (highest first):
 *  1. opts.executablePath — forces chrome with that exact binary.
 *  2. BOWSER_BACKEND=webkit|chrome — overrides auto-detection.
 *  3. Auto: native WebKit on macOS (unless an explicit Chromium is installed via
 *     `bowser install` or BOWSER_CHROMIUM_PATH), chrome elsewhere.
 *  Note: a programmatic opts.executablePath wins over BOWSER_BACKEND — a chromium
 *  binary path can't drive the webkit engine, so chrome is the only valid choice. */
export async function openBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  // An explicit executablePath always forces chrome with that exact binary
  // (the detect fn is unused because pathOverride short-circuits it);
  // otherwise resolveBackend() decides.
  const spec = opts.executablePath
    ? chromeBackend(process.env, () => undefined, opts.executablePath)
    : resolveBackend();
  let view: Bun.WebView;
  try {
    view = new Bun.WebView({
      backend: toBunBackend(spec),
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
  return wrapView(view, spec, NAV_TIMING, opts.profile ? { profile: opts.profile } : undefined);
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
 *  settleMs; an action that navigates nowhere costs the full grace window. */
function navigationWatch(
  view: ViewLike,
  timing: NavTiming,
  onNavigation: () => void = () => {},
  onLanded: () => void = onNavigation,
) {
  // One watch per view: this takes over the view's navigation callbacks, so
  // wrapView must be called once per view (openBrowser does).
  // A failed navigation ends the wait but does not fail the action: WebKit
  // reports NSURLErrorDomain -999 for routine cancellations (a page script
  // navigating right after a click), and `state` reads the real URL anyway.
  // Surfacing the last navigation error is future DaemonState work.
  let landed = 0;
  view.onNavigated = () => { landed++; onLanded(); };
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

/** A persistent store, and how `close` waits for Chromium to write it.
 *  The check and the cap are injectable for tests. */
export interface PersistentStore {
  profile: string;
  /** Whether our Chromium still runs on `profile`. Must stop when `signal` aborts. */
  chromiumRunning?: (signal: AbortSignal) => Promise<boolean>;
  /** Hard deadline for the whole wait, checks included. */
  exitCapMs?: number;
}

/** Turn a view into a Browser. Separate from openBrowser so tests can pass a
 *  fake view; openBrowser is the only caller with a real one. */
export function wrapView(view: ViewLike, spec: Backend, timing: NavTiming = NAV_TIMING, store?: PersistentStore): Browser {
  const profile = store?.profile;
  let dialogs: DialogListener | undefined;
  // On chrome Bun fires onNavigated for an iframe landing too, with no frame
  // to tell it apart (measured, Bun 1.4.2), so a landing is not a navigation
  // there: the main frame's Page.frameStartedNavigating (watchDialogs) comes
  // first anyway. On webkit a landing is the only signal the page gives.
  const navigated = () => dialogs?.navigation();
  const nav = navigationWatch(view, timing, navigated, spec.kind === "chrome" ? () => {} : navigated);
  const cdp = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    // view.cdp() exists on the chrome backend only. On webkit Bun throws
    // 'WebView.cdp() requires backend: "chrome"'; we raise the friendlier
    // shared message instead.
    if (spec.kind !== "chrome" || typeof view.cdp !== "function") {
      return Promise.reject(new Error(CDP_UNAVAILABLE));
    }
    return view.cdp(method, params);
  };
  const subscribe = (event: string, handler: (data: unknown) => void): boolean => {
    // webkit accepts addEventListener and silently never fires it, so
    // registering there would report success and deliver nothing.
    if (spec.kind !== "chrome") return false;
    view.addEventListener(event, (e) => handler(e.data));
    return true;
  };

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
      // Both engines write a persistent profile lazily, and the daemon exits
      // right after this, so each must be made to flush first (measured: a
      // localStorage item written just before `close` was lost 14 times in
      // 15 on WebKit; on Chromium cookies and localStorage were both lost).
      if (profile && spec.kind === "chrome" && typeof view.cdp === "function") {
        // CDP Browser.close is Chromium's own orderly shutdown. The pipe
        // closes before it has finished writing, so wait for the process.
        try {
          await view.cdp("Browser.close");
        } catch {}
        await waitUntilGone(
          store?.chromiumRunning ?? ((signal) => chromiumRunning(profile, signal)),
          store?.exitCapMs ?? 1500,
        );
      } else if (profile) {
        // WebKit hands a page's storage over when the page goes away;
        // leaving it for about:blank kept the item 40 times in 40.
        try {
          await view.navigate("about:blank");
        } catch {}
      }
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      view.close?.();
    },
    cdpAvailable(): boolean {
      return spec.kind === "chrome";
    },
    cdp,
    subscribe,
    watchDialogs(on) {
      dialogs = on;
      const watching = subscribe("Page.javascriptDialogOpening", (data) => {
        const d = data as { type: DialogState["type"]; message: string; defaultPrompt?: string };
        on.opened({
          type: d.type,
          message: d.message,
          ...(d.type === "prompt" ? { defaultValue: d.defaultPrompt ?? "" } : {}),
        });
      });
      // Chrome says when any navigation starts, the page's own included,
      // before the new document can open a dialog. Only the main frame's
      // count: an iframe navigating leaves the page's one-shot answer alone.
      // The event carries no parent id, so the main frame's id is asked for
      // once: a page target's id is its main frame's id. Target.getTargetInfo,
      // not Page.getFrameTree: the browser process answers it, while
      // getFrameTree needs the renderer, which a load-time dialog blocks, and
      // `open` then hung (measured, Bun 1.4.2, 2 runs in 3). It needs the CDP
      // session, which exists by the first event. Unknown, the event counts:
      // dropping an answer is the safe side.
      let mainFrame: string | undefined;
      let asking: Promise<string | undefined> | undefined;
      const main = () => (asking ??= cdp("Target.getTargetInfo")
        .then((r) => (mainFrame = (r as { targetInfo: { targetId: string } }).targetInfo.targetId))
        .catch(() => { asking = undefined; return undefined; }));
      subscribe("Page.frameStartedNavigating", (data) => {
        const { frameId } = data as { frameId: string };
        if (mainFrame !== undefined) {
          if (frameId === mainFrame) on.navigation();
          return;
        }
        void main().then((id) => { if (id === undefined || frameId === id) on.navigation(); });
      });
      return watching;
    },
    answerDialog: async (accept, promptText) => {
      await cdp("Page.handleJavaScriptDialog", promptText === undefined ? { accept } : { accept, promptText });
    },
  };
}

/** Poll `running` until it reports false, under one hard deadline that
 *  also bounds each check: a check still pending at the deadline is aborted
 *  and abandoned. Chromium's profile has no lock file to watch
 *  (chrome-headless-shell writes no SingletonLock), so the check is `ps`. */
async function waitUntilGone(running: (signal: AbortSignal) => Promise<boolean>, capMs: number): Promise<void> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((r) => { timer = setTimeout(r, capMs); });
  const poll = (async () => {
    while (!ctl.signal.aborted && (await running(ctl.signal))) await Bun.sleep(20);
  })().catch(() => {});
  await Promise.race([poll, deadline]);
  clearTimeout(timer);
  ctl.abort();
}

/** True while a Chromium started by this process runs on `profile`: a direct
 *  child of ours (Bun spawns it) with `--user-data-dir=<profile>`, so no other
 *  process using the same directory counts. Aborting kills the `ps`. */
async function chromiumRunning(profile: string, signal: AbortSignal): Promise<boolean> {
  const flag = `--user-data-dir=${profile}`;
  try {
    const proc = Bun.spawn(["ps", "-axww", "-o", "ppid=,command="], { stdout: "pipe", stderr: "ignore", signal });
    const lines = (await new Response(proc.stdout).text()).split("\n");
    return lines.some((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) !== process.pid) return false;
      return m[2]!.includes(`${flag} `) || m[2]!.endsWith(flag);
    });
  } catch {
    return false;
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

/** Decode whatever Bun.WebView.screenshot() returns into raw PNG bytes.
 *  Current Bun returns a Blob (type image/png); we also accept a base64 string
 *  defensively in case the API shape changes. */
export async function pngBytesFrom(data: Blob | string): Promise<Uint8Array> {
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
  return new Uint8Array(await data.arrayBuffer());
}
