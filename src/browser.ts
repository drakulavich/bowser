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

  const backend =
    path || extraArgv.length > 0
      ? ({
          type: "chrome" as const,
          ...(path ? { path } : {}),
          ...(extraArgv.length ? { argv: extraArgv } : {}),
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
    "/usr/bin/chromium-headless-shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...playwrightCacheCandidates(),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      // statSync via Bun.file — fast enough at startup.
      if (Bun.file(p).size >= 0) return p;
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/** Look inside Playwright's browser cache (~/.cache/ms-playwright) for a
 *  chrome-headless-shell install. We don't parse versions — we glob the
 *  directory and return the first match. */
function playwrightCacheCandidates(): string[] {
  const home = process.env.HOME;
  if (!home) return [];

  const roots = [
    `${home}/.cache/ms-playwright`,
    `${home}/Library/Caches/ms-playwright`,
  ];
  const out: string[] = [];

  for (const root of roots) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (!entry.startsWith("chromium")) continue;
        // Linux: chromium_headless_shell-XXXX/chrome-linux/headless_shell
        //   or: chromium-XXXX/chrome-linux/chrome
        // macOS: .../chrome-mac/Chromium.app/Contents/MacOS/Chromium
        const base = `${root}/${entry}`;
        out.push(
          // Playwright chromium-headless-shell (what --only-shell installs)
          `${base}/chrome-headless-shell-linux64/chrome-headless-shell`,
          `${base}/chrome-headless-shell-mac-arm64/headless_shell`,
          `${base}/chrome-headless-shell-mac/headless_shell`,
          // Playwright full chromium
          `${base}/chrome-linux64/chrome`,
          `${base}/chrome-linux/chrome`,
          `${base}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
          `${base}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`,
        );
      }
    } catch {
      // ignore
    }
  }
  return out;
}
