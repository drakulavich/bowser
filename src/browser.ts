// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView; backend choice lives in backend.ts.

import { chromeBackend, resolveBackend, toBunBackend } from "./backend.ts";

export interface BrowserOptions {
  executablePath?: string;
  width?: number;
  height?: number;
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
}

/** Open a Bun.WebView. Backend precedence (highest first):
 *  1. opts.executablePath — forces chrome with that exact binary.
 *  2. BOWSER_BACKEND=webkit|chrome — overrides auto-detection.
 *  3. Auto: native WebKit on macOS (unless an explicit Chromium is installed via
 *     `bowser install` or BOWSER_CHROMIUM_PATH), chrome elsewhere.
 *  Note: a programmatic opts.executablePath wins over BOWSER_BACKEND — a chromium
 *  binary path can't drive the webkit engine, so chrome is the only valid choice. */
export async function openBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  // Choose webkit (native macOS) vs chrome. An explicit executablePath always
  // forces chrome with that exact binary (the detect fn is unused here because
  // pathOverride short-circuits it); otherwise resolveBackend() decides.
  const spec = opts.executablePath
    ? chromeBackend(process.env, () => undefined, opts.executablePath)
    : resolveBackend();

  const view = new Bun.WebView({
    backend: toBunBackend(spec),
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
  });

  return {
    get url() {
      return view.url as string;
    },
    get title() {
      return view.title as string;
    },
    realUrl: () => resolveUrl(view.url as string, () => view.evaluate("location.href")),
    realTitle: () => resolveTitle(view.title as string, () => view.evaluate("document.title")),
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
      const data = await (view as { screenshot?: () => Promise<Blob | string> }).screenshot?.();
      if (!data) throw new Error('screenshot: not supported by this Bun.WebView');
      const bytes = await pngBytesFrom(data);
      if (!isLikelyPng(bytes)) {
        throw new Error('screenshot: WebView returned an empty/invalid image');
      }
      return Buffer.from(bytes).toString('base64');
    },
    resize: async (width: number, height: number) => {
      // Bun.WebView.resize() is native and works on both backends.
      await (view as unknown as { resize: (w: number, h: number) => Promise<void> }).resize(width, height);
    },
    back: async () => {
      await view.evaluate("history.back()");
    },
    forward: async () => {
      await view.evaluate("history.forward()");
    },
    reload: async () => {
      if (typeof (view as { reload?: unknown }).reload === 'function') {
        await (view as { reload: () => Promise<void> }).reload();
      } else {
        await view.evaluate("location.reload()");
      }
    },
    close: async () => {
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      await view.close?.();
    },
    cdpAvailable(): boolean {
      return spec.kind === "chrome";
    },
    cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
      // view.cdp() is available on the chrome backend only. On webkit it throws
      // "WebView.cdp() requires backend: \"chrome\"". We surface a friendlier
      // error that matches the daemon op's wording.
      if (spec.kind !== "chrome") {
        return Promise.reject(
          new Error(
            "CDP is only available on the chrome backend (current: webkit) — " +
            "run 'bowser install' to use Chromium-backed features",
          ),
        );
      }
      return (view as unknown as { cdp: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).cdp(method, params);
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
