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

  const backend = path
    ? ({ type: "chrome", path } as const)
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
