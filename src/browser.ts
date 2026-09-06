// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView; backend choice lives in backend.ts.

import { chromeBackend, resolveBackend, toBunBackend } from "./backend.ts";
import type { Cookie, CookieParam, DeleteCookieOptions } from "./cdp/types.ts";
import type { Backend } from "./backend.ts";

export interface BrowserOptions {
  executablePath?: string;
  width?: number;
  height?: number;
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
  // --- Cookies: CDP-backed, so chrome only. Each rejects with CDP_UNAVAILABLE on webkit. ---
  getCookies(urls?: string[]): Promise<Cookie[]>;
  setCookie(param: CookieParam): Promise<{ success: boolean }>;
  deleteCookies(name: string, opts?: DeleteCookieOptions): Promise<void>;
  clearCookies(): Promise<void>;
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
  const view = new Bun.WebView({
    backend: toBunBackend(spec),
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
  });
  // The real Bun.WebView satisfies ViewLike structurally; no cast needed here.
  return wrapView(view, spec);
}

/** Turn a view into a Browser. Separate from openBrowser so tests can pass a
 *  fake view; openBrowser is the only caller with a real one. */
export function wrapView(view: ViewLike, spec: Backend): Browser {
  const cdp = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    // view.cdp() exists on the chrome backend only. On webkit Bun throws
    // 'WebView.cdp() requires backend: "chrome"'; we raise the friendlier
    // shared message instead.
    if (spec.kind !== "chrome" || typeof view.cdp !== "function") {
      return Promise.reject(new Error(CDP_UNAVAILABLE));
    }
    return view.cdp(method, params);
  };

  return {
    get url() { return view.url; },
    get title() { return view.title; },
    realUrl: () => resolveUrl(view.url, () => view.evaluate("location.href")),
    realTitle: () => resolveTitle(view.title, () => view.evaluate("document.title")),
    navigate: (url) => view.navigate(url),
    evaluate: (expr) => view.evaluate(expr),
    click: (selector) => view.click(selector),
    type: (text) => view.type(text),
    press: (key) => view.press(key),
    hover: async (selector) => {
      await view.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('hover: element not found');
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      })()`);
    },
    select: async (selector, value) => {
      await view.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('select: element not found');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    },
    setChecked: async (selector, checked) => {
      await view.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('check: element not found');
        if (Boolean(el.checked) !== ${checked}) el.click();
      })()`);
    },
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
    back: async () => {
      await view.evaluate("history.back()");
    },
    forward: async () => {
      await view.evaluate("history.forward()");
    },
    reload: async () => {
      if (typeof view.reload === "function") {
        await view.reload();
      } else {
        await view.evaluate("location.reload()");
      }
    },
    close: async () => {
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      view.close?.();
    },
    cdpAvailable(): boolean {
      return spec.kind === "chrome";
    },
    cdp,
    getCookies: async (urls) => {
      const scoped = urls !== undefined && urls.length > 0;
      const res = (await cdp(
        scoped ? "Network.getCookies" : "Network.getAllCookies",
        scoped ? { urls } : undefined,
      )) as { cookies: Cookie[] };
      return res.cookies;
    },
    setCookie: async (param) => {
      const res = (await cdp("Network.setCookie", param as unknown as Record<string, unknown>)) as { success: boolean };
      return { success: res.success };
    },
    deleteCookies: async (name, opts) => {
      // `opts ?? {}`, not a default parameter: a request carrying null must
      // behave like one carrying nothing (wire compatibility, PR 2 review).
      const o = opts ?? {};
      const params: Record<string, unknown> = { name };
      if (o.url) params.url = o.url;
      if (o.domain) params.domain = o.domain;
      if (o.path) params.path = o.path;
      await cdp("Network.deleteCookies", params);
    },
    clearCookies: async () => {
      await cdp("Network.clearBrowserCookies");
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
