// Thin wrapper around Bun.WebView so tests can mock it.

export interface BrowserOptions {
  executablePath?: string;
  width?: number;
  height?: number;
}

export interface Browser {
  navigate(url: string): Promise<void>;
  evaluate(expr: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  url: string;
  title: string;
  close(): Promise<void>;
}

/** Open a real Bun.WebView against an installed Chromium. */
export async function openBrowser(opts: BrowserOptions = {}): Promise<Browser> {
  const path = opts.executablePath ?? detectChromium();

  // Extra Chrome launch flags can be injected via BOWSER_CHROME_ARGS
  // (space-separated). On CI (sandboxed containers, no user namespaces) you
  // typically want BOWSER_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage".
  const extraArgv = (process.env.BOWSER_CHROME_ARGS ?? "")
    .split(/\s+/)
    .filter(Boolean);

  // BOWSER_CHROME_DEBUG=1 forwards Chrome stderr to our stderr so spawn
  // failures in CI don't hide behind "Chrome process closed the pipe".
  const debug = process.env.BOWSER_CHROME_DEBUG === "1";

  const backend =
    path || extraArgv.length > 0 || debug
      ? ({
          type: "chrome" as const,
          ...(path ? { path } : {}),
          ...(extraArgv.length ? { argv: extraArgv } : {}),
          ...(debug ? { stderr: "inherit", stdout: "inherit" } : {}),
        } as const)
      : ("chrome" as const);

  // @ts-expect-error Bun.WebView is available in Bun >= 1.3.12 but not yet in
  // the public types bundled with @types/bun at the time of writing.
  const view = new Bun.WebView({
    backend,
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
    navigate: (url) => view.navigate(url),
    evaluate: (expr) => view.evaluate(expr),
    click: (selector) => view.click(selector),
    type: (text) => view.type(text),
    press: (key) => view.press(key),
    close: async () => {
      // Bun.WebView implements Symbol.asyncDispose; calling close() is the
      // explicit form.
      await view.close?.();
    },
  };
}

/** Look in a handful of standard locations. Bun does its own detection too,
 *  but being explicit gives better error messages. */
export function detectChromium(): string | undefined {
  const candidates = [
    process.env.BOWSER_CHROMIUM_PATH,
    ...bowserCacheCandidates(),
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

/** Root of bowser's dedicated chromium cache. `bowser install` downloads into
 *  here via Playwright's installer (with PLAYWRIGHT_BROWSERS_PATH pointed at
 *  this directory). Nothing else on the machine writes to this path. */
export function bowserCacheRoot(): string {
  const home = process.env.HOME ?? "";
  return `${home}/.bowser/chromium`;
}

/** Expand the bowser-owned cache into concrete executable candidate paths.
 *  Layout mirrors Playwright's because we use Playwright's installer. */
function bowserCacheCandidates(): string[] {
  const root = bowserCacheRoot();
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
        `${base}/chrome-headless-shell-mac-arm64/headless_shell`,
        `${base}/chrome-headless-shell-mac/headless_shell`,
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
