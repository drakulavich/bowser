# Native WebKit Backend on macOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS, drive `Bun.WebView`'s native `webkit` backend by default, switching to `chrome` only when the user opted into Chromium (`bowser install` cache or `BOWSER_CHROMIUM_PATH`), with a `BOWSER_BACKEND` override.

**Architecture:** Introduce a pure `resolveBackend()` decision function plus a narrow `hasExplicitChromium()` predicate and a `toBunBackend()` mapper in `src/browser.ts`. `openBrowser()` calls `resolveBackend()` instead of the current hardcoded `"chrome"` literal. All decision logic is pure and dependency-injected, so it is unit-tested without a real browser.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

Reference spec: `docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md`.

---

## File Structure

- **Modify** `src/browser.ts` — add `Backend` type, `hasExplicitChromium()`, `resolveBackend()`, `toBunBackend()`; rewrite the backend block inside `openBrowser()`.
- **Create** `tests/backend.test.ts` — unit tests for the three new functions.
- **Modify** `README.md`, `skills/bowser/SKILL.md`, `CLAUDE.md` (a.k.a. `AGENTS.md`, symlinked) — document `BOWSER_BACKEND` and macOS-default behavior.

All new logic lives in `src/browser.ts` (where backend construction already lives) to keep "files that change together live together."

---

## Task 1: `hasExplicitChromium()` predicate

Narrow detector for "user opted into Chromium": `BOWSER_CHROMIUM_PATH` exists **or** the `~/.bowser/chromium` cache holds a binary. Deliberately excludes system Chrome paths (unlike `detectChromium()`).

**Files:**
- Modify: `src/browser.ts` (add exported function near `detectChromium`, ~line 156)
- Test: `tests/backend.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/backend.test.ts`:

```ts
// Unit tests for backend selection. No real browser; fs tests use a tmp HOME.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasExplicitChromium, bowserCacheRoot } from "../src/browser.ts";

describe("hasExplicitChromium", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origPath: string | undefined;

  beforeEach(async () => {
    tmp = join(tmpdir(), `bowser-backend-${Date.now()}-${Math.random()}`);
    await mkdir(tmp, { recursive: true });
    origHome = process.env.HOME;
    origPath = process.env.BOWSER_CHROMIUM_PATH;
    process.env.HOME = tmp;
    delete process.env.BOWSER_CHROMIUM_PATH;
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origPath !== undefined) process.env.BOWSER_CHROMIUM_PATH = origPath;
    else delete process.env.BOWSER_CHROMIUM_PATH;
    await rm(tmp, { recursive: true, force: true });
  });

  test("false when no cache and no env", () => {
    expect(hasExplicitChromium()).toBe(false);
  });

  test("true when BOWSER_CHROMIUM_PATH points at an existing file", () => {
    process.env.BOWSER_CHROMIUM_PATH = "/bin/sh";
    expect(hasExplicitChromium()).toBe(true);
  });

  test("false when BOWSER_CHROMIUM_PATH points at a missing file", () => {
    process.env.BOWSER_CHROMIUM_PATH = join(tmp, "nope");
    expect(hasExplicitChromium()).toBe(false);
  });

  test("true when the bowser cache holds a binary", async () => {
    const dir = join(bowserCacheRoot(), "chromium-1140", "chrome-headless-shell-mac-arm64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "chrome-headless-shell"), "#!/bin/sh\n");
    expect(hasExplicitChromium()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backend.test.ts`
Expected: FAIL — `hasExplicitChromium` is not exported from `../src/browser.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/browser.ts`, add after `detectChromium()` (it must see the in-file private `bowserCacheCandidates()`):

```ts
/** True iff the user explicitly opted into Chromium: BOWSER_CHROMIUM_PATH points
 *  at a real file, or the bowser-managed cache (`bowser install`) holds a binary.
 *  Deliberately excludes system Chrome paths — those are a valid chrome *path*
 *  but must NOT trigger the macOS webkit→chrome switch. */
export function hasExplicitChromium(): boolean {
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
  if (exists(process.env.BOWSER_CHROMIUM_PATH)) return true;
  return bowserCacheCandidates().some(exists);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backend.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/backend.test.ts
git commit -m "feat: add hasExplicitChromium predicate for backend selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `Backend` type + `resolveBackend()`

Pure decision function. Platform, env, and both detectors are injectable.

**Files:**
- Modify: `src/browser.ts` (add `Backend` type + `chromeBackend` helper + `resolveBackend` near top, after `BrowserOptions`)
- Test: `tests/backend.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend.test.ts`:

```ts
import { resolveBackend } from "../src/browser.ts";

describe("resolveBackend", () => {
  const noChromium = () => false;
  const yesChromium = () => true;
  const noDetect = () => undefined;
  const detectPath = () => "/path/to/chrome";

  test("macOS, no explicit chromium -> webkit", () => {
    expect(
      resolveBackend({ platform: "darwin", env: {}, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "webkit" });
  });

  test("macOS, explicit chromium -> chrome with detected path", () => {
    expect(
      resolveBackend({ platform: "darwin", env: {}, hasExplicitChromium: yesChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "chrome", path: "/path/to/chrome" });
  });

  test("linux -> chrome regardless of explicit chromium", () => {
    expect(
      resolveBackend({ platform: "linux", env: {}, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "chrome" });
  });

  test("BOWSER_BACKEND=webkit wins over explicit chromium on macOS", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "webkit" }, hasExplicitChromium: yesChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "webkit" });
  });

  test("BOWSER_BACKEND=chrome wins over webkit default on macOS", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "chrome" }, hasExplicitChromium: noChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "chrome", path: "/path/to/chrome" });
  });

  test("BOWSER_BACKEND=webkit on non-macOS throws", () => {
    expect(() =>
      resolveBackend({ platform: "linux", env: { BOWSER_BACKEND: "webkit" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toThrow("only supported on macOS");
  });

  test("invalid BOWSER_BACKEND throws", () => {
    expect(() =>
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "firefox" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toThrow("invalid BOWSER_BACKEND");
  });

  test("chrome carries argv + debug from env", () => {
    expect(
      resolveBackend({ platform: "linux", env: { BOWSER_CHROME_ARGS: "--no-sandbox --foo", BOWSER_CHROME_DEBUG: "1" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "chrome", argv: ["--no-sandbox", "--foo"], debug: true });
  });

  test("webkit ignores chrome-only env args (no flip to chrome)", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_CHROME_ARGS: "--no-sandbox" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "webkit" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backend.test.ts`
Expected: FAIL — `resolveBackend` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/browser.ts`, add after the `BrowserOptions` interface (top of file):

```ts
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

/** Decide which Bun.WebView backend to use. Pure: all inputs injectable.
 *  Order: explicit BOWSER_BACKEND > macOS-without-explicit-chromium=webkit >
 *  chrome. See docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md. */
export function resolveBackend(deps: ResolveBackendDeps = {}): Backend {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const hasExplicit = deps.hasExplicitChromium ?? hasExplicitChromium;
  const detect = deps.detectChromium ?? detectChromium;

  const override = env.BOWSER_BACKEND;
  if (override !== undefined && override !== "") {
    if (override !== "webkit" && override !== "chrome") {
      throw new Error(
        `invalid BOWSER_BACKEND='${override}' (expected 'webkit' or 'chrome')`,
      );
    }
    if (override === "webkit") {
      if (platform !== "darwin") {
        throw new Error("BOWSER_BACKEND=webkit is only supported on macOS");
      }
      return { kind: "webkit" };
    }
    return chromeBackend(env, detect);
  }

  if (platform === "darwin" && !hasExplicit()) {
    return { kind: "webkit" };
  }
  return chromeBackend(env, detect);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backend.test.ts`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/backend.test.ts
git commit -m "feat: add resolveBackend backend-selection logic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `toBunBackend()` mapper

Translate the internal `Backend` union into the shape `Bun.WebView` expects for its `backend` field (string for the bare cases, object for the tuned chrome case).

**Files:**
- Modify: `src/browser.ts` (add exported `toBunBackend` after `resolveBackend`)
- Test: `tests/backend.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend.test.ts`:

```ts
import { toBunBackend } from "../src/browser.ts";

describe("toBunBackend", () => {
  test("webkit -> 'webkit' string", () => {
    expect(toBunBackend({ kind: "webkit" })).toBe("webkit");
  });

  test("bare chrome -> 'chrome' string", () => {
    expect(toBunBackend({ kind: "chrome" })).toBe("chrome");
  });

  test("chrome with path -> object form", () => {
    expect(toBunBackend({ kind: "chrome", path: "/p" })).toEqual({ type: "chrome", path: "/p" });
  });

  test("chrome with argv -> object form", () => {
    expect(toBunBackend({ kind: "chrome", argv: ["--no-sandbox"] })).toEqual({ type: "chrome", argv: ["--no-sandbox"] });
  });

  test("chrome with debug -> inherits stdio", () => {
    expect(toBunBackend({ kind: "chrome", debug: true })).toEqual({ type: "chrome", stderr: "inherit", stdout: "inherit" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backend.test.ts`
Expected: FAIL — `toBunBackend` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/browser.ts`, add after `resolveBackend`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backend.test.ts`
Expected: PASS (all backend tests).

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/backend.test.ts
git commit -m "feat: add toBunBackend mapper for Bun.WebView backend field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `openBrowser()` to use the resolver

Replace the hardcoded `"chrome"` block (current lines ~29–58) with a call to `resolveBackend()` + `toBunBackend()`, preserving the `opts.executablePath` override (an explicit path forces chrome with that path).

**Files:**
- Modify: `src/browser.ts:27-58` (`openBrowser` head)

No new unit test: `openBrowser` constructs a real `Bun.WebView`, which needs a browser. The decision logic is already covered by Tasks 1–3; the chrome path is exercised by the existing e2e suite (which sets `BOWSER_CHROMIUM_PATH`, keeping it on chrome). The webkit path is verified manually in Step 4.

- [ ] **Step 1: Replace the backend block**

In `src/browser.ts`, replace everything from `const path = opts.executablePath ?? detectChromium();` through the `const view = new Bun.WebView({ ... });` declaration (the block currently spanning ~lines 29–58) with:

```ts
  // Choose webkit (native macOS) vs chrome. An explicit executablePath always
  // forces chrome with that binary; otherwise resolveBackend() decides.
  const spec = opts.executablePath
    ? chromeBackend(process.env, detectChromium, opts.executablePath)
    : resolveBackend();

  // @ts-expect-error Bun.WebView is available in Bun >= 1.3.12 but not yet in
  // the public types bundled with @types/bun at the time of writing.
  const view = new Bun.WebView({
    backend: toBunBackend(spec),
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
  });
```

(The old `extraArgv` / `debug` / `backend` locals are removed — that logic now lives in `chromeBackend`. Update the `openBrowser` doc-comment at line 27 to: `/** Open a Bun.WebView using the resolved backend (native webkit on macOS, else chrome). */`.)

- [ ] **Step 2: Typecheck + full unit suite**

Run: `bun test`
Expected: PASS — all existing tests plus `tests/backend.test.ts`. No Chromium needed for these.

- [ ] **Step 3: Verify chrome path still works (e2e, opted-in)**

Run:
```bash
BOWSER_E2E=1 \
  BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
  bun test tests/e2e.test.ts
```
Expected: PASS — `BOWSER_CHROMIUM_PATH` makes `hasExplicitChromium()` true, so resolution stays on chrome (unchanged behavior).

- [ ] **Step 4: Verify webkit path manually (macOS only)**

Run:
```bash
unset BOWSER_CHROMIUM_PATH
bun run src/cli.ts open https://example.com --session wktest
bun run src/cli.ts snapshot --session wktest
bun run src/cli.ts close --session wktest
```
Expected: the snapshot prints aria-tree YAML for example.com with **no** `~/.bowser/chromium` present (native WKWebView). If a cache exists from a prior `bowser install`, temporarily test with `BOWSER_BACKEND=webkit` prefixed instead.

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts
git commit -m "feat: default to native webkit backend on macOS in openBrowser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md` (env-vars / backend section)
- Modify: `skills/bowser/SKILL.md` (env / troubleshooting)
- Modify: `CLAUDE.md` (Conventions or Gotchas section; `AGENTS.md` is a symlink to it)

- [ ] **Step 1: Document in README.md**

Add a "Browser backend" subsection (place it near install / environment-variable docs). Verbatim content:

```markdown
### Browser backend

On macOS, bowser uses the native `WKWebView` engine by default — nothing to install.
It switches to Chrome/Chromium automatically if you opted in by running
`bowser install` (which caches a headless Chromium under `~/.bowser/chromium`) or by
setting `BOWSER_CHROMIUM_PATH`. On Linux and Windows it always uses Chrome/Chromium.

Override the choice with `BOWSER_BACKEND`:

| Value | Effect |
| --- | --- |
| `BOWSER_BACKEND=webkit` | Force native WebKit (macOS only; errors elsewhere). |
| `BOWSER_BACKEND=chrome` | Force Chrome/Chromium. |

**Note:** `screenshot` may be unsupported on the WebKit backend. If you need
screenshots on macOS, use `BOWSER_BACKEND=chrome` or run `bowser install`.
```

- [ ] **Step 2: Document in skills/bowser/SKILL.md**

Add the same information, condensed, wherever environment variables / troubleshooting are listed:

```markdown
- **Backend**: macOS defaults to native WebKit; `bowser install` or
  `BOWSER_CHROMIUM_PATH` switches to Chromium. Force with
  `BOWSER_BACKEND=webkit|chrome`. `screenshot` may require the chrome backend.
```

- [ ] **Step 3: Document in CLAUDE.md (Conventions)**

Add a bullet under "## Conventions":

```markdown
- **Backend selection lives in `resolveBackend()`** (`src/browser.ts`). macOS
  defaults to native `webkit`; it switches to `chrome` only on *explicit* opt-in
  (`hasExplicitChromium()` — bowser cache or `BOWSER_CHROMIUM_PATH`), never on
  incidental system Chrome. `BOWSER_BACKEND=webkit|chrome` overrides. Keep the
  trigger (cache/env) distinct from the chrome *path* resolver (`detectChromium()`,
  which may use system Chrome).
```

- [ ] **Step 4: Commit**

```bash
git add README.md skills/bowser/SKILL.md CLAUDE.md
git commit -m "docs: document BOWSER_BACKEND and macOS native webkit default

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done-When

- `bun test` is green, including `tests/backend.test.ts`.
- On macOS with no `~/.bowser/chromium` and no `BOWSER_CHROMIUM_PATH`, `bowser open` drives native WKWebView.
- After `bowser install` (or with `BOWSER_CHROMIUM_PATH` set), `bowser open` drives Chromium.
- `BOWSER_BACKEND=webkit|chrome` overrides; invalid values and `webkit` off-macOS error clearly.
- Non-macOS behavior is unchanged.
- README, SKILL.md, and CLAUDE.md document the behavior.
