// Which engine Bun.WebView runs, and where a Chromium binary lives. Pure
// decisions plus filesystem probes; nothing here touches a WebView. Imported
// by browser.ts (to open the view), daemon/client.ts (to fail fast on a bad
// BOWSER_BACKEND before spawning) and commands/install.ts.

export type Backend =
  | { kind: "webkit" }
  | { kind: "chrome"; path?: string; argv?: string[]; debug?: boolean };

export interface ResolveBackendDeps {
  platform?: string;
  env?: Record<string, string | undefined>;
  hasExplicitChromium?: () => boolean;
  detectChromium?: () => string | undefined;
}

export function chromeBackend(
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

/** The `backend` option Bun.WebView's constructor accepts. Derived from the
 *  constructor so it tracks bun-types instead of a hand-copied union. */
type BunBackend = NonNullable<
  NonNullable<ConstructorParameters<typeof Bun.WebView>[0]>["backend"]
>;

/** Map our Backend union to the value Bun.WebView's `backend` field accepts:
 *  a bare string when there's nothing to tune, an object otherwise. */
export function toBunBackend(b: Backend): BunBackend {
  if (b.kind === "webkit") return "webkit";
  if (!b.path && !b.argv && !b.debug) return "chrome";
  return {
    type: "chrome",
    ...(b.path ? { path: b.path } : {}),
    ...(b.argv ? { argv: b.argv } : {}),
    ...(b.debug ? { stderr: "inherit", stdout: "inherit" } : {}),
  };
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
