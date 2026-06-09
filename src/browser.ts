// Thin wrapper around Bun.WebView so tests can mock it.

export interface BrowserOptions {
  executablePath?: string;
  width?: number;
  height?: number;
}

export type Backend =
  | { kind: "webkit" }
  | { kind: "chrome"; path?: string; argv?: string[]; debug?: boolean };

export interface ResolveBackendDeps {
  platform?: string;
  env?: Record<string, string | undefined>;
  hasExplicitChromium?: () => boolean;
  detectChromium?: () => string | undefined;
}

function chromeBackend(
  env: Record<string, string | undefined>,
  detect: () => string | undefined,
  pathOverride?: string,
): Backend {
  const path = pathOverride ?? detect();
  const argv = (env.BOWSER_CHROME_ARGS ?? "").split(/\s+/).filter(Boolean);
  const debug = env.BOWSER_CHROME_DEBUG === "1";
  return {
    kind: "chrome",
    ...(path ? { path } : {}),
    ...(argv.length ? { argv } : {}),
    ...(debug ? { debug: true } : {}),
  };
}

/** Validate the BOWSER_BACKEND override without any detection or I/O. Throws the
 *  same errors resolveBackend() surfaces for a bad override. The parent CLI calls
 *  this before spawning the detached daemon, so a typo'd value fails fast with a
 *  clear message instead of being swallowed by the daemon and seen only as a
 *  "did not start in time" timeout. */
export function assertValidBackendEnv(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): void {
  const override = env.BOWSER_BACKEND;
  if (override === undefined || override === "") return;
  if (override !== "webkit" && override !== "chrome") {
    throw new Error(
      `invalid BOWSER_BACKEND='${override}' (expected 'webkit' or 'chrome')`,
    );
  }
  if (override === "webkit" && platform !== "darwin") {
    throw new Error("BOWSER_BACKEND=webkit is only supported on macOS");
  }
}

/** Decide which Bun.WebView backend to use. Pure: all inputs injectable.
 *  Order: explicit BOWSER_BACKEND > macOS-without-explicit-chromium=webkit >
 *  chrome. See docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md. */
export function resolveBackend(deps: ResolveBackendDeps = {}): Backend {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  // Thread the resolved env into the default detectors so an injected
  // `deps.env` governs the webkit/chrome switch and the chrome path
  // consistently — not just chromeBackend's argv/debug parsing.
  const hasExplicit = deps.hasExplicitChromium ?? (() => hasExplicitChromium(env));
  const detect = deps.detectChromium ?? (() => detectChromium(env));

  assertValidBackendEnv(env, platform);

  const override = env.BOWSER_BACKEND;
  if (override === "webkit") return { kind: "webkit" };
  if (override === "chrome") return chromeBackend(env, detect);

  if (platform === "darwin" && !hasExplicit()) {
    return { kind: "webkit" };
  }
  return chromeBackend(env, detect);
}

/** Map our Backend union to the value Bun.WebView's `backend` field accepts:
 *  a bare string when there's nothing to tune, an object otherwise. */
export function toBunBackend(b: Backend): unknown {
  if (b.kind === "webkit") return "webkit";
  if (!b.path && !b.argv && !b.debug) return "chrome";
  return {
    type: "chrome",
    ...(b.path ? { path: b.path } : {}),
    ...(b.argv ? { argv: b.argv } : {}),
    ...(b.debug ? { stderr: "inherit", stdout: "inherit" } : {}),
  };
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

export interface Browser {
  url: string;
  title: string;
  realUrl(): Promise<string>;
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  setChecked(selector: string, checked: boolean): Promise<void>;
  screenshot(): Promise<string>; // base64-encoded PNG (full page)
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

  // @ts-expect-error Bun.WebView is available in Bun >= 1.3.12 but not yet in
  // the public types bundled with @types/bun at the time of writing.
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
            "cookie commands require the chrome backend " +
            "(run 'bowser install' and set BOWSER_BACKEND=chrome, " +
            "or rely on the bowser-managed Chromium)",
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

/** Look in a handful of standard locations. Bun does its own detection too,
 *  but being explicit gives better error messages. */
export function detectChromium(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const candidates = [
    env.BOWSER_CHROMIUM_PATH,
    ...bowserCacheCandidates(env),
    "/usr/bin/chromium-headless-shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean) as string[];

  const fs = require("node:fs") as typeof import("node:fs");
  for (const p of candidates) {
    try {
      // Must exist and be a regular file (not a symlink to /dev/null etc).
      const st = fs.statSync(p);
      if (st.isFile() || st.isSymbolicLink()) return p;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/** True iff the user explicitly opted into Chromium: BOWSER_CHROMIUM_PATH points
 *  at a real file, or the bowser-managed cache (`bowser install`) holds a binary.
 *  Deliberately excludes system Chrome paths — those are a valid chrome *path*
 *  but must NOT trigger the macOS webkit→chrome switch. */
export function hasExplicitChromium(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const fs = require("node:fs") as typeof import("node:fs");
  const exists = (p: string | undefined): boolean => {
    if (!p) return false;
    try {
      const st = fs.statSync(p);
      return st.isFile() || st.isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (exists(env.BOWSER_CHROMIUM_PATH)) return true;
  return bowserCacheCandidates(env).some(exists);
}

/** Root of bowser's dedicated chromium cache. `bowser install` downloads into
 *  here via Playwright's installer (with PLAYWRIGHT_BROWSERS_PATH pointed at
 *  this directory). Nothing else on the machine writes to this path. */
export function bowserCacheRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HOME ?? "";
  return `${home}/.bowser/chromium`;
}

/** Expand the bowser-owned cache into concrete executable candidate paths.
 *  Layout mirrors Playwright's because we use Playwright's installer. */
function bowserCacheCandidates(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const root = bowserCacheRoot(env);
  if (!root) return [];

  const out: string[] = [];
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(root)) return [];
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith("chromium")) continue;
      const base = `${root}/${entry}`;
      out.push(
        // chromium-headless-shell (what `bowser install` fetches)
        `${base}/chrome-headless-shell-linux64/chrome-headless-shell`,
        `${base}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
        `${base}/chrome-headless-shell-mac/chrome-headless-shell`,
        // Full chromium, in case someone installs the heavier build
        `${base}/chrome-linux64/chrome`,
        `${base}/chrome-linux/chrome`,
        `${base}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`,
      );
    }
  } catch {
    // ignore
  }
  return out;
}
