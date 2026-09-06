# Refactor PR 3: Browser absorbs cookies and history, backend.ts split, CDP gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Browser` becomes the only place that knows CDP cookie methods and how navigation settles; backend selection moves out of `browser.ts` into `backend.ts`; the daemon refuses CDP-only ops on webkit before their handler runs; and the two WebKit e2e todos that blamed "the native-history change" turn into passing tests.

**Architecture:** `browser.ts` gains a `wrapView(view, spec)` seam: it turns anything with the `ViewLike` shape into a `Browser`, so the cookie mapping and the navigation watch are unit-tested against a fake view while `openBrowser` stays the one `new Bun.WebView(...)` site. Cookie ops become four `Browser` methods and the daemon handlers become one-liners. `DaemonOps` entries that need CDP carry a `requires: "cdp"` marker mirrored by a `satisfies`-checked runtime set; `createHandler` answers those ops on webkit with today's exact error text. History goes native where the runtime has it (`goBack`/`goForward`/`reload`), and every action that may start a navigation (`click`, `press`, `back`, `forward`, emulated reload) waits for that navigation to land before returning, which is what makes `state` right after `click` report the new URL.

**Tech Stack:** Bun 1.4.0 (`Bun.WebView`), TypeScript 7.0.2 (`bun run typecheck` is the gate), bun:test. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` — Section 1 (layout: `backend.ts`, layer rules), Section 4 ("Capability gate", "`Browser` absorbs CDP details"), Section 6 row 3.

## Probe results this plan relies on (2026-09-06, Bun 1.4.0, WebKit, local `Bun.serve` pages)

Measured with a throwaway script, not recalled:

- The runtime `Bun.WebView` prototype has `goBack`, `goForward`, `reload`, `loading`, `onNavigated`, `onNavigationFailed`. `@types/bun` declares `back()`/`forward()` instead of `goBack()`/`goForward()`; `view.back` is `undefined` at runtime.
- `view.click(link)` resolves with `url` still the old page and `loading === false`; `onNavigated` fires ~30 ms later. Native `goBack()`/`goForward()` resolve in 0 ms; `onNavigated` fires ~2 ms later and `url` updates within ~25 ms. `history.back()` via `evaluate` behaves identically. So native history does not by itself fix "state after click/back reports the old URL"; a watch on `loading`/`onNavigated` does.
- Native `reload()` resolves after the reload commits: `navigate()` right after it succeeds. `evaluate("location.reload()")` followed by `navigate()` fails with `NSURLErrorDomain error -999` every time. Native reload fixes the todo.
- `press("Enter")` still fires no bubbling `keydown` on WebKit. That todo stays.

## Global Constraints

- Zero runtime dependencies (`package.json` `dependencies` stays absent).
- Wire format, op names, CLI output strings and `--json` shapes are unchanged. The only behavioral change is that `click`, `press`, `go-back`, `go-forward` (and `reload` on a Bun without native reload) return after a navigation they started has landed, and `reload` uses the native call.
- The CDP error text is byte-identical to today's: `CDP is only available on the chrome backend (current: webkit) — run 'bowser install' to use Chromium-backed features` (note the em dash). It is now a single exported constant, `CDP_UNAVAILABLE` in `src/browser.ts`.
- `src/browser.ts` remains the only file with `new Bun.WebView(`; `src/daemon/server.ts` remains the only caller of `openBrowser`.
- `OP_META`, `urgent` markers and `DaemonState` belong to PR 6. This PR adds only the `requires: "cdp"` marker and its runtime set.
- Layer rules after this PR (all enforced by `tests/layers.test.ts`): `commands.ts` has no value import of `browser.ts` or `daemon/server.ts`; `daemon/client.ts` has no value import of `browser.ts`; `backend.ts`, `snapshot.ts`, `serialize.ts`, `socket-write.ts`, `daemon/protocol.ts` have no value imports from `src/`.
- Every commit carries the trailer lines `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj`.
- Per-task gate: `bun run typecheck && bun test`. Tasks 4 and 5 also run the WebKit and Chromium e2e suites; Task 5 also runs the compiled-binary smoke because `daemon/client.ts` changes in Task 1.

---

### Task 1: `src/backend.ts` — backend selection leaves `browser.ts`

**Files:**
- Create: `src/backend.ts`
- Modify: `src/browser.ts` (delete the moved code; import what `openBrowser` needs)
- Modify: `src/commands.ts:5`, `src/daemon/client.ts:7`
- Modify: `tests/backend.test.ts:8`, `tests/install.test.ts:14`, `tests/e2e.test.ts:13`, `tests/e2e-cookie.test.ts:18`, `tests/e2e-search.test.ts:16`, `tests/e2e-todo.test.ts:12`
- Modify: `tests/layers.test.ts` (rule 3 list, rule 4 predicate and title, new rule 5)

**Interfaces:**
- Produces: `src/backend.ts` exporting `Backend`, `ResolveBackendDeps`, `chromeBackend`, `assertValidBackendEnv`, `resolveBackend`, `toBunBackend`, `detectChromium`, `hasExplicitChromium`, `bowserCacheRoot`. Same signatures and bodies as today in `src/browser.ts`. `chromeBackend` is newly exported (it was module-private) because `openBrowser` calls it.
- `src/browser.ts` keeps `BrowserOptions`, `resolveUrl`, `resolveTitle`, `Browser`, `openBrowser`, `isLikelyPng`, `pngBytesFrom`, `PNG_SIGNATURE`.

- [ ] **Step 1: Create `src/backend.ts` by moving code verbatim**

Move these from `src/browser.ts`, in this order, bodies unchanged except that `chromeBackend` gains `export`: the `Backend` type, `ResolveBackendDeps`, `chromeBackend`, `assertValidBackendEnv`, `resolveBackend`, the `BunBackend` type alias, `toBunBackend`, `detectChromium`, `hasExplicitChromium`, `bowserCacheRoot`, `bowserCacheCandidates`. File header:

```ts
// Which engine Bun.WebView runs, and where a Chromium binary lives. Pure
// decisions plus filesystem probes; nothing here touches a WebView. Imported
// by browser.ts (to open the view), daemon/client.ts (to fail fast on a bad
// BOWSER_BACKEND before spawning) and commands.ts (`install`).
```

`toBunBackend` keeps its `ConstructorParameters<typeof Bun.WebView>` type derivation; that is a type position, not an instantiation, so the layer rule "only browser.ts instantiates Bun.WebView" still holds.

- [ ] **Step 2: Trim `src/browser.ts`**

Replace its header and imports with:

```ts
// The daemon's handle on one Bun.WebView. This is the only file that
// instantiates Bun.WebView; backend choice lives in backend.ts.

import { chromeBackend, resolveBackend, toBunBackend } from "./backend.ts";
```

Delete the moved declarations. `openBrowser` is unchanged and now resolves `chromeBackend`, `resolveBackend`, `toBunBackend` through the import.

- [ ] **Step 3: Repoint importers**

- `src/commands.ts`: `import { bowserCacheRoot, detectChromium } from "./backend.ts";`
- `src/daemon/client.ts`: `import { assertValidBackendEnv } from "../backend.ts";`
- `tests/backend.test.ts`: `import { hasExplicitChromium, bowserCacheRoot, resolveBackend, toBunBackend, assertValidBackendEnv } from "../src/backend.ts";` plus `import { isLikelyPng } from "../src/browser.ts";`
- `tests/install.test.ts`: `bowserCacheRoot` from `../src/backend.ts`.
- `tests/e2e.test.ts`: `detectChromium, resolveBackend` from `../src/backend.ts`; `isLikelyPng` stays from `../src/browser.ts`.
- `tests/e2e-cookie.test.ts`, `tests/e2e-search.test.ts`: `detectChromium` from `../src/backend.ts`.
- `tests/e2e-todo.test.ts`: `detectChromium, resolveBackend` from `../src/backend.ts`; `openBrowser` stays from `../src/browser.ts`.

Grep afterwards: `grep -rn "from \"\.\./src/browser.ts\"\|from \"\./browser.ts\"\|from \"\.\./browser.ts\"" src tests` must list only `src/daemon/server.ts`, `tests/daemon-handler.test.ts`, `tests/e2e.test.ts`, `tests/resolve-title.test.ts`, `tests/resolve-url.test.ts`, `tests/backend.test.ts`, `tests/screenshot.test.ts`, `tests/e2e-todo.test.ts`.

- [ ] **Step 4: Layer rules**

In `tests/layers.test.ts`:

Rule 3's file list gains `"src/backend.ts"`; its name becomes `"backend.ts, snapshot.ts, serialize.ts, socket-write.ts and daemon/protocol.ts have no value imports from src"`.

Rule 4 becomes:

```ts
  {
    name: "commands.ts talks to the daemon only through client.ts and protocol.ts",
    violates: (file, text) =>
      file === "src/commands.ts" &&
      valueImports(text).some((s) => s.endsWith("browser.ts") || s.endsWith("daemon/server.ts")),
  },
```

New rule 5, appended:

```ts
  {
    name: "daemon/client.ts does not import browser.ts (backend checks come from backend.ts)",
    violates: (file, text) =>
      file === "src/daemon/client.ts" && valueImports(text).some((s) => s.endsWith("browser.ts")),
  },
```

- [ ] **Step 5: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: typecheck clean; same pass count as before the task (289 pass; the layer suite gains one test, so 290 pass).

```bash
git add src/backend.ts src/browser.ts src/commands.ts src/daemon/client.ts tests/backend.test.ts tests/install.test.ts tests/e2e.test.ts tests/e2e-cookie.test.ts tests/e2e-search.test.ts tests/e2e-todo.test.ts tests/layers.test.ts
git commit -m "refactor: move backend selection out of browser.ts into backend.ts

commands.ts and daemon/client.ts needed Chromium detection and the
BOWSER_BACKEND check, not a WebView; importing browser.ts for them tied
the CLI process to the daemon's module. The layer test now forbids it."
```

---

### Task 2: `wrapView` seam and cookie methods on `Browser`

**Files:**
- Modify: `src/browser.ts` (add `CDP_UNAVAILABLE`, `ViewLike`, `wrapView`; extend `Browser`; `openBrowser` becomes three lines)
- Modify: `src/daemon/server.ts` (cookie handlers become one-liners; drop the `Cookie` import)
- Create: `tests/browser.test.ts`
- Modify: `tests/daemon-handler.test.ts` (fake gains four methods; cookie tests assert Browser calls)

**Interfaces:**
- Produces: `export const CDP_UNAVAILABLE: string`; `export interface ViewLike`; `export function wrapView(view: ViewLike, spec: Backend): Browser`; `Browser` gains `getCookies(urls?: string[]): Promise<Cookie[]>`, `setCookie(param: CookieParam): Promise<{ success: boolean }>`, `deleteCookies(name: string, opts?: DeleteCookieOptions): Promise<void>`, `clearCookies(): Promise<void>`.
- Consumes: `chromeBackend`, `resolveBackend`, `toBunBackend`, `Backend` from Task 1.

- [ ] **Step 1: Write the failing tests**

`tests/browser.test.ts`:

```ts
// wrapView() against a fake view: the cookie methods pick the CDP call the
// old daemon switch picked, and every CDP path on webkit fails with the one
// shared message before touching the view.
import { describe, expect, test } from "bun:test";
import { CDP_UNAVAILABLE, wrapView, type ViewLike } from "../src/browser.ts";

type Calls = Array<[string, unknown[]]>;

function fakeView(): ViewLike & { calls: Calls } {
  const calls: Calls = [];
  return {
    calls,
    url: "https://x/",
    title: "X",
    navigate: async (url) => { calls.push(["navigate", [url]]); },
    evaluate: async (expr) => { calls.push(["evaluate", [expr]]); return undefined; },
    click: async (s) => { calls.push(["click", [s]]); },
    type: async (t) => { calls.push(["type", [t]]); },
    press: async (k) => { calls.push(["press", [k]]); },
    resize: async (w, h) => { calls.push(["resize", [w, h]]); },
    cdp: async (m, p) => { calls.push(["cdp", [m, p]]); return { cookies: [{ name: "a", value: "1" }], success: true }; },
  };
}

const chrome = { kind: "chrome" as const };
const webkit = { kind: "webkit" as const };

describe("wrapView cookies", () => {
  test("getCookies scopes to Network.getCookies only when urls are given", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome);
    expect(await b.getCookies(["https://x/"])).toEqual([{ name: "a", value: "1" }]);
    await b.getCookies();
    await b.getCookies([]);
    expect(v.calls).toEqual([
      ["cdp", ["Network.getCookies", { urls: ["https://x/"] }]],
      ["cdp", ["Network.getAllCookies", undefined]],
      ["cdp", ["Network.getAllCookies", undefined]],
    ]);
  });

  test("setCookie returns the success flag", async () => {
    const v = fakeView();
    expect(await wrapView(v, chrome).setCookie({ name: "a", value: "1" })).toEqual({ success: true });
    expect(v.calls).toEqual([["cdp", ["Network.setCookie", { name: "a", value: "1" }]]]);
  });

  test("deleteCookies forwards only the options that were set", async () => {
    const v = fakeView();
    await wrapView(v, chrome).deleteCookies("sid", { domain: "x" });
    expect(v.calls).toEqual([["cdp", ["Network.deleteCookies", { name: "sid", domain: "x" }]]]);
  });

  test("deleteCookies treats null options like an empty object", async () => {
    const v = fakeView();
    await wrapView(v, chrome).deleteCookies("sid", null as never);
    expect(v.calls).toEqual([["cdp", ["Network.deleteCookies", { name: "sid" }]]]);
  });

  test("clearCookies calls Network.clearBrowserCookies", async () => {
    const v = fakeView();
    await wrapView(v, chrome).clearCookies();
    expect(v.calls).toEqual([["cdp", ["Network.clearBrowserCookies", undefined]]]);
  });

  test("on webkit every cookie method rejects with CDP_UNAVAILABLE and never reaches the view", async () => {
    const v = fakeView();
    const b = wrapView(v, webkit);
    expect(b.cdpAvailable()).toBe(false);
    await expect(b.getCookies()).rejects.toThrow(CDP_UNAVAILABLE);
    await expect(b.clearCookies()).rejects.toThrow(CDP_UNAVAILABLE);
    await expect(b.cdp("Network.enable")).rejects.toThrow(CDP_UNAVAILABLE);
    expect(v.calls).toEqual([]);
  });
});
```

In `tests/daemon-handler.test.ts`, extend `fakeBrowser` after the `cdp:` line:

```ts
    getCookies: rec("getCookies", [{ name: "a", value: "1" }]),
    setCookie: rec("setCookie", { success: true }),
    deleteCookies: rec("deleteCookies", undefined),
    clearCookies: rec("clearCookies", undefined),
```

Replace the three tests `cookie-get-all scopes…`, `cookie-delete forwards only…`, `cookie-delete treats a null options…` with one:

```ts
  test("cookie ops forward to the Browser's cookie methods", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    expect(await h(req("cookie-get-all", [["https://x/"]]))).toEqual({ id: 7, ok: true, result: [{ name: "a", value: "1" }] });
    await h(req("cookie-set", [{ name: "a", value: "1" }]));
    await h(req("cookie-delete", ["sid", { domain: "x" }]));
    await h(req("cookie-clear"));
    expect(b.calls).toEqual([
      ["getCookies", [["https://x/"]]],
      ["setCookie", [{ name: "a", value: "1" }]],
      ["deleteCookies", ["sid", { domain: "x" }]],
      ["clearCookies", []],
    ]);
  });
```

Run: `bun run typecheck` → fails (`wrapView`, `CDP_UNAVAILABLE`, `ViewLike` missing; `Browser` lacks the four methods). `bun test tests/browser.test.ts` fails to import.

- [ ] **Step 2: Implement in `src/browser.ts`**

Add after the imports (keep `BrowserOptions`, `resolveUrl`, `resolveTitle` as they are):

```ts
import type { Cookie, CookieParam, DeleteCookieOptions } from "./cdp/types.ts";
import type { Backend } from "./backend.ts";

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
```

Extend `Browser` (after `cdp`):

```ts
  // --- Cookies: CDP-backed, so chrome only. Each rejects with CDP_UNAVAILABLE on webkit. ---
  getCookies(urls?: string[]): Promise<Cookie[]>;
  setCookie(param: CookieParam): Promise<{ success: boolean }>;
  deleteCookies(name: string, opts?: DeleteCookieOptions): Promise<void>;
  clearCookies(): Promise<void>;
```

Replace `openBrowser`'s returned object literal with a call to `wrapView`, and add `wrapView`:

```ts
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
    hover: async (selector) => { /* body verbatim from today's openBrowser */ },
    select: async (selector, value) => { /* verbatim */ },
    setChecked: async (selector, checked) => { /* verbatim */ },
    screenshot: async () => {
      // Bun.WebView.screenshot() returns a Blob (image/png) for the full page.
      const data = await view.screenshot?.();
      if (!data) throw new Error("screenshot: not supported by this Bun.WebView");
      const bytes = await pngBytesFrom(data);
      if (!isLikelyPng(bytes)) throw new Error("screenshot: WebView returned an empty/invalid image");
      return Buffer.from(bytes).toString("base64");
    },
    resize: (width, height) => view.resize(width, height),
    back: async () => { await view.evaluate("history.back()"); },
    forward: async () => { await view.evaluate("history.forward()"); },
    reload: async () => {
      if (typeof view.reload === "function") await view.reload();
      else await view.evaluate("location.reload()");
    },
    close: async () => { view.close?.(); },
    cdpAvailable: () => spec.kind === "chrome",
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
    clearCookies: async () => { await cdp("Network.clearBrowserCookies"); },
  };
}
```

The `hover`, `select`, `setChecked` bodies are the exact strings in today's `openBrowser` (they contain the `JSON.stringify(selector)` quoting that CLAUDE.md calls mandatory); copy them, do not retype them. The old `resize` and `cdp` casts on `view` disappear because `ViewLike` declares those members. If `tsc` rejects passing the real `Bun.WebView` where `ViewLike` is expected, narrow it once at the `wrapView(view, spec)` call with `view as unknown as ViewLike` and a one-line comment naming the mismatching member; do not widen `ViewLike`.

- [ ] **Step 3: Handlers become one-liners in `src/daemon/server.ts`**

Replace the four cookie handlers with:

```ts
  // --- Cookie ops (chrome only; the Browser rejects them on webkit) ---
  "cookie-get-all": (browser, urls) => browser.getCookies(urls),
  "cookie-set": (browser, param) => browser.setCookie(param),
  "cookie-delete": (browser, name, opts) => browser.deleteCookies(name, opts),
  "cookie-clear": (browser) => browser.clearCookies(),
```

`Browser.deleteCookies` already treats a `null` from the wire like `undefined` (test "deleteCookies treats null options like an empty object"), so the handler passes `opts` through. Remove `import type { Cookie } from "../cdp/types.ts";` from `server.ts` if nothing else uses it.

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green. `tests/browser.test.ts` adds 6 tests; `tests/daemon-handler.test.ts` goes from 11 to 9 (three cookie tests became one). Net 294 pass.

```bash
git add src/browser.ts src/daemon/server.ts tests/browser.test.ts tests/daemon-handler.test.ts
git commit -m "refactor: Browser owns the cookie CDP calls; wrapView makes it unit-testable

The daemon handlers knew Network.getCookies vs getAllCookies and which
deleteCookies fields to send. That is a Browser concern. wrapView(view,
spec) separates building a Browser from opening a WebView, so the mapping
is tested against a fake view instead of a fake Browser."
```

---

### Task 3: `requires: "cdp"` marker and the daemon gate

**Files:**
- Modify: `src/daemon/protocol.ts` (markers on four ops; `CdpOp`, `REQUIRES_CDP`)
- Modify: `src/daemon/server.ts` (`createHandler` gate)
- Modify: `tests/protocol.test.ts`, `tests/daemon-handler.test.ts`

**Interfaces:**
- Produces: `export type CdpOp` (the ops whose entry has `requires: "cdp"`); `export const REQUIRES_CDP: ReadonlySet<Op>`.
- Consumes: `CDP_UNAVAILABLE` from `src/browser.ts` (Task 2).

- [ ] **Step 1: Failing tests**

`tests/protocol.test.ts`: add to the imports `CdpOp, REQUIRES_CDP` (value import for `REQUIRES_CDP`; `CdpOp` is a type). Inside `typeChecks()` add:

```ts
  // requires: "cdp" is visible to the type system.
  const cdpOp: CdpOp = "cookie-set";
  // @ts-expect-error state needs no CDP
  const notCdp: CdpOp = "state";
  void [cdpOp, notCdp];
```

Add a runtime test:

```ts
  test("REQUIRES_CDP lists exactly the cookie ops", () => {
    expect([...REQUIRES_CDP].sort()).toEqual(["cookie-clear", "cookie-delete", "cookie-get-all", "cookie-set"]);
  });
```

`tests/daemon-handler.test.ts`: import `CDP_UNAVAILABLE` from `../src/browser.ts` and add:

```ts
  test("a cdp op on webkit is refused with the shared message before the handler runs", async () => {
    const b = fakeBrowser({ cdpAvailable: () => false });
    expect(await createHandler(b)(req("cookie-clear"))).toEqual({ id: 7, ok: false, error: CDP_UNAVAILABLE });
    expect(b.calls).toEqual([]);
  });

  test("a non-cdp op still runs when cdp is unavailable", async () => {
    const b = fakeBrowser({ cdpAvailable: () => false });
    expect(await createHandler(b)(req("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
  });
```

Run: `bun run typecheck` fails (no `CdpOp`, `REQUIRES_CDP`); the gate test fails because the handler reaches `clearCookies`.

- [ ] **Step 2: Protocol markers**

In `src/daemon/protocol.ts`, the four cookie entries gain a third field:

```ts
  "cookie-get-all": { args: [urls?: string[]];                           result: Cookie[];             requires: "cdp" };
  "cookie-set":     { args: [param: CookieParam];                        result: { success: boolean }; requires: "cdp" };
  "cookie-delete":  { args: [name: string, opts?: DeleteCookieOptions];  result: void;                 requires: "cdp" };
  "cookie-clear":   { args: [];                                          result: void;                 requires: "cdp" };
```

After `ResultOf` add:

```ts
/** Ops whose handler needs Bun.WebView.cdp(), i.e. the chrome backend. */
export type CdpOp = { [O in Op]: DaemonOps[O] extends { requires: "cdp" } ? O : never }[Op];

// The runtime mirror of the `requires: "cdp"` markers. `satisfies` makes a
// marker without a row here, or a row without a marker, fail typecheck.
// PR 6 folds this into OP_META when urgent routing arrives.
const CDP_OPS = {
  "cookie-get-all": true,
  "cookie-set": true,
  "cookie-delete": true,
  "cookie-clear": true,
} satisfies Record<CdpOp, true>;

export const REQUIRES_CDP: ReadonlySet<Op> = new Set<Op>(Object.keys(CDP_OPS) as CdpOp[]);
```

- [ ] **Step 3: The gate in `createHandler`**

In `src/daemon/server.ts` import `REQUIRES_CDP` from `./protocol.ts` (it becomes a value import; `protocol.ts` still imports nothing from `src/`, so rule 3 holds) and `CDP_UNAVAILABLE` from `../browser.ts`. After the unknown-op check:

```ts
    // Capability gate: a CDP-only op on webkit fails here with the shared
    // message, so the handler never touches a view that cannot answer.
    if (REQUIRES_CDP.has(req.op) && !browser.cdpAvailable()) {
      return { id: req.id, ok: false, error: CDP_UNAVAILABLE };
    }
```

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green; 297 pass.

```bash
git add src/daemon/protocol.ts src/daemon/server.ts tests/protocol.test.ts tests/daemon-handler.test.ts
git commit -m "feat: ops that need CDP say so in DaemonOps and are refused on webkit before dispatch

requires: \"cdp\" on the four cookie ops, mirrored by a satisfies-checked
set the daemon consults before calling the handler. Same error text as
before; the Browser-level rejection stays as a backstop."
```

---

### Task 4: native history and the navigation watch

**Files:**
- Modify: `src/browser.ts` (`ViewLike` gains `loading`, `onNavigated`, `onNavigationFailed`, `goBack`, `goForward`; `NavTiming`, `NAV_TIMING`, `navigationWatch`; `wrapView` takes `timing`; `click`, `press`, `back`, `forward`, `reload` change)
- Modify: `tests/browser.test.ts` (fake view grows; six new tests)
- Modify: `tests/e2e-webkit.test.ts` (two `test.todo` → `test`; one comment)

**Interfaces:**
- Produces: `export interface NavTiming { graceMs: number; settleMs: number }`, `export const NAV_TIMING: NavTiming = { graceMs: 100, settleMs: 10_000 }`, `wrapView(view, spec, timing = NAV_TIMING)`.

- [ ] **Step 1: Failing tests**

In `tests/browser.test.ts`, change `fakeView` so the returned object is mutable and can simulate a landing. Replace it with:

```ts
type Fake = ViewLike & { calls: Calls; loading: boolean; url: string; land(url: string): void };

function fakeView(over: Partial<ViewLike> = {}): Fake {
  const calls: Calls = [];
  const v: Fake = {
    calls,
    url: "https://x/",
    title: "X",
    loading: false,
    onNavigated: null,
    onNavigationFailed: null,
    navigate: async (url) => { calls.push(["navigate", [url]]); v.url = url; },
    evaluate: async (expr) => { calls.push(["evaluate", [expr]]); return undefined; },
    click: async (s) => { calls.push(["click", [s]]); },
    type: async (t) => { calls.push(["type", [t]]); },
    press: async (k) => { calls.push(["press", [k]]); },
    resize: async (w, h) => { calls.push(["resize", [w, h]]); },
    cdp: async (m, p) => { calls.push(["cdp", [m, p]]); return { cookies: [{ name: "a", value: "1" }], success: true }; },
    /** A navigation lands: url changes, loading ends, onNavigated fires. */
    land(url) { v.url = url; v.loading = false; v.onNavigated?.(url, ""); },
    ...over,
  };
  return v;
}
```

Add a second describe block:

```ts
const fast = { graceMs: 40, settleMs: 300 };

describe("wrapView navigation watch", () => {
  test("click returns after a navigation that lands inside the grace window", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); setTimeout(() => v.land("https://x/two"), 10); };
    const b = wrapView(v, chrome, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/two");
  });

  test("click that navigates nowhere returns after the grace window", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome, fast);
    const t0 = Date.now();
    await b.click("#btn");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(fast.graceMs - 5);
    expect(b.url).toBe("https://x/");
  });

  test("a navigation that starts inside the grace window is awaited past it", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; setTimeout(() => v.land("https://x/slow"), 120); };
    const b = wrapView(v, chrome, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/slow");
  });

  test("a navigation that never lands is given up after settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; };
    const b = wrapView(v, chrome, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await b.click("#l");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(v.loading).toBe(true);
  });

  test("back and forward use goBack/goForward when the runtime has them", async () => {
    const v = fakeView({
      goBack: async () => { v.calls.push(["goBack", []]); },
      goForward: async () => { v.calls.push(["goForward", []]); },
    });
    const b = wrapView(v, chrome, fast);
    await b.back();
    await b.forward();
    expect(v.calls).toEqual([["goBack", []], ["goForward", []]]);
  });

  test("back, forward and reload fall back to history/location when the runtime lacks them", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome, fast);
    await b.back();
    await b.forward();
    await b.reload();
    expect(v.calls).toEqual([
      ["evaluate", ["history.back()"]],
      ["evaluate", ["history.forward()"]],
      ["evaluate", ["location.reload()"]],
    ]);
  });

  test("reload prefers the native call, which resolves when the reload commits", async () => {
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); } });
    await wrapView(v, chrome, fast).reload();
    expect(v.calls).toEqual([["reload", []]]);
  });
});
```

Note the two fakes that declare `v.calls` inside `over` closures reference `v` before it is assigned; that is fine because the arrow functions run later. If `tsc` complains about `v` being used before assignment, hoist `const calls` and push to it instead.

Run: `bun run typecheck` fails (`wrapView` has no third parameter; `ViewLike` lacks `loading`).

- [ ] **Step 2: Implement in `src/browser.ts`**

Extend `ViewLike`:

```ts
  /** True while a navigation is in flight. */
  readonly loading: boolean;
  onNavigated: ((url: string, title: string) => void) | null;
  onNavigationFailed: ((error: Error) => void) | null;
  /** Runtime names. @types/bun (1.4.0) declares back()/forward() instead;
   *  those do not exist on the object. Do not "fix" these to match the types. */
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
```

Add before `wrapView`:

```ts
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
function navigationWatch(view: ViewLike, timing: NavTiming) {
  let landed = 0;
  view.onNavigated = () => { landed++; };
  view.onNavigationFailed = () => { landed++; };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    async act(action: () => Promise<void>): Promise<void> {
      const before = landed;
      await action();
      const start = Date.now();
      while (Date.now() - start < timing.graceMs) {
        if (landed !== before) return;
        if (view.loading) break;
        await sleep(10);
      }
      const began = Date.now();
      while (view.loading && landed === before && Date.now() - began < timing.settleMs) await sleep(10);
    },
  };
}
```

Change `wrapView`'s signature to `export function wrapView(view: ViewLike, spec: Backend, timing: NavTiming = NAV_TIMING): Browser`, create `const nav = navigationWatch(view, timing);` at the top, and change these members:

```ts
    click: (selector) => nav.act(() => view.click(selector)),
    press: (key) => nav.act(() => view.press(key)),
    back: () => nav.act(async () => {
      if (typeof view.goBack === "function") await view.goBack();
      else await view.evaluate("history.back()");
    }),
    forward: () => nav.act(async () => {
      if (typeof view.goForward === "function") await view.goForward();
      else await view.evaluate("history.forward()");
    }),
    reload: async () => {
      // Native reload resolves after the reload commits (probe: goto right
      // after it succeeds; after location.reload() it fails with -999).
      if (typeof view.reload === "function") await view.reload();
      else await nav.act(async () => { await view.evaluate("location.reload()"); });
    },
```

`navigate` is untouched: `view.navigate` already resolves on completion.

- [ ] **Step 3: Flip the two WebKit todos**

In `tests/e2e-webkit.test.ts`:

- `test.todo("click reports the post-navigation url: …")` → `test("click reports the post-navigation url", …)`, body unchanged.
- `test.todo("reload then goto: WebKit rejects …")` → `test("reload then goto: native reload resolves after its navigation commits", …)`, body unchanged.
- In the test `click a link, then go-back, go-forward, goto`, replace the comment `// The page itself is the witness that the click navigated. What \`click\`\n    // *reports* as the URL is a separate question, pinned in the todo below.` with `// The page itself is the witness that the click navigated; what \`click\`\n    // reports is checked by the next test.`
- The `press` todo stays exactly as it is.

- [ ] **Step 4: Verify**

```bash
cd <worktree> && bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test tests/e2e-webkit.test.ts tests/e2e.test.ts tests/e2e-todo.test.ts
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
```

Expected: unit 304 pass; WebKit e2e 18 pass / 1 todo (press) / 0 fail; Chromium e2e green. Wrap each e2e command in `perl -e 'alarm 900; exec @ARGV or die' --` (macOS has no `timeout`). Afterwards `pgrep -fl "daemon/main|--daemon"` prints nothing.

If the Chromium suite regresses on `click` or history (for example `loading` never flips on chrome and every click costs `settleMs`), keep the watch and file the exact symptom in the report; do not disable the watch per backend without a ruling.

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/browser.test.ts tests/e2e-webkit.test.ts
git commit -m "fix: actions that start a navigation wait for it to land; reload goes native

click, press, go-back and go-forward resolved before the page they
triggered committed, so state right after them reported the old URL.
Browser now watches onNavigated/loading and waits up to 10 s for a
navigation that begins within 100 ms of the action. Native reload
resolves after the reload commits, which fixes goto-after-reload
failing with NSURLErrorDomain -999 on WebKit. Two e2e todos become tests."
```

---

### Task 5: Docs, changelog, spec notes, full gate, PR

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md`, `openspec/specs/GLOSSARY.md` (only if it names `browser.ts` for backend selection)

- [ ] **Step 1: CLAUDE.md**

"Where to look first" table: change the row `| WebView / Chromium glue? | \`src/browser.ts\` |` to two rows:

```
| WebView glue (Browser, cookies, navigation watch)? | `src/browser.ts` (`wrapView`, `openBrowser`) |
| Backend choice / Chromium detection? | `src/backend.ts` (`resolveBackend`, `detectChromium`, `hasExplicitChromium`) |
```

Conventions bullet `**Backend selection lives in \`resolveBackend()\`** (\`src/browser.ts\`)` → `(\`src/backend.ts\`)`; rest unchanged.

"Adding a command" step 1, append a sentence: `If the op needs CDP, add \`requires: "cdp"\` to its \`DaemonOps\` entry and a row to \`CDP_OPS\` in the same file; the daemon then answers webkit callers with \`CDP_UNAVAILABLE\` before the handler runs.`

Gotchas, add two bullets:

```
- **`Bun.WebView` history methods are `goBack()`/`goForward()` at runtime.** `@types/bun` declares `back()`/`forward()`, which are `undefined` on the object (Bun 1.4.0). `ViewLike` in `src/browser.ts` names the runtime methods and probes them with `typeof`; do not rename them to match the types.
- **Actions that can navigate go through `nav.act()`.** `click`, `press`, `back`, `forward` and emulated `reload` wait for a navigation that begins within 100 ms and let it land (10 s cap) before returning; that is why `state` right after `click` reports the new URL. A new action that may trigger a navigation must be wrapped the same way, or its reported URL will be stale.
```

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **WebKit: `goto` right after `reload` failed with `NSURLErrorDomain -999`.** `reload` now uses
  `Bun.WebView.reload()`, which resolves after the reload commits.
- **`click`, `press`, `go-back`, `go-forward` reported the URL of the page they were leaving.** The
  browser now waits for a navigation the action started (begins within 100 ms, lands within 10 s)
  before answering, on both backends.
```

Under `### Changed`, edit the bullet `**Known WebKit limitations, now pinned as \`test.todo\`:**` so it lists only `press` (`\`press\` fires no bubbling \`keydown\``), and append:

```markdown
- **`src/backend.ts`.** Backend selection and Chromium detection moved out of `src/browser.ts`;
  `browser.ts` is now only the `Browser` over one `Bun.WebView`, built by `wrapView()`.
- **Cookie ops are `Browser` methods; CDP-only ops are refused on webkit before dispatch.** The four
  `cookie-*` ops carry `requires: "cdp"` in `DaemonOps`; the daemon answers with the same error text
  as before without calling the handler.
```

- [ ] **Step 3: Spec notes**

In `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md`:

- "Findings" section: append one bullet: `- **Native history does not fix stale URLs by itself (2026-09-06 probe, Bun 1.4.0).** \`goBack()\`/\`goForward()\` resolve immediately, like the \`history.back()\` emulation; \`onNavigated\` fires ~2 ms later and \`url\` updates within ~25 ms. \`click()\` resolves ~30 ms before its navigation commits. PR 3 adds a navigation watch in \`Browser\` (wait for a navigation that begins within 100 ms, up to 10 s). Native \`reload()\` does resolve after the reload commits and fixes the \`-999\` failure. The runtime methods are \`goBack\`/\`goForward\`; \`@types/bun\` declares \`back\`/\`forward\`.`
- "Open questions": replace the bullet beginning `- Whether native \`view.goBack()\` resolves on the same event` with `- (Answered in PR 3, see Findings.) Native \`goBack()\` resolves on the same event as the emulation; the fix was a navigation watch, not the native call.`

- [ ] **Step 4: Full gate, push, PR**

```bash
cd <worktree> && bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
bun build src/cli.ts --compile --outfile dist/bowser && BOWSER_BACKEND=webkit ./dist/bowser open https://example.com && ./dist/bowser snapshot && ./dist/bowser close
pgrep -fl "daemon/main|--daemon"
```

Expected: all green; the three binary commands each return to the shell promptly; pgrep prints nothing. Wrap e2e and binary commands in `perl -e 'alarm 900; exec @ARGV or die' --`.

```bash
git add CLAUDE.md CHANGELOG.md docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md openspec/specs/GLOSSARY.md
git commit -m "docs: backend.ts, Browser cookie methods, the navigation watch and the CDP gate"
git push -u origin refactor/3-browser-backend
gh pr create --base main --title "Refactor PR 3: Browser absorbs cookies and history, backend.ts, CDP gate" --body-file - <<'EOF'
Third PR of the maintainability series (spec: docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md, Sections 1 and 4).

- `src/backend.ts`: backend selection and Chromium detection leave `browser.ts`; `commands.ts` and `daemon/client.ts` no longer import `browser.ts` (layer test).
- `wrapView(view, spec)` builds a `Browser` from anything view-shaped, so cookie mapping and the navigation watch are unit-tested against a fake view. `openBrowser` is the only `new Bun.WebView`.
- Cookie ops are `Browser` methods; the daemon handlers are one-liners. `requires: "cdp"` on the four cookie ops, mirrored by a `satisfies`-checked set; the daemon refuses them on webkit with the same error text as before, before the handler runs.
- Navigation watch: `click`, `press`, `go-back`, `go-forward` wait for a navigation they started to land. `reload` goes native. Two WebKit e2e todos are now passing tests (post-click URL; goto after reload). `press` keydown stays a todo (Bun/WebKit limitation).

Not in this PR: `OP_META`/urgent routing and `DaemonState` (PR 6), commands split (PR 4).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj
EOF
```

---

## Self-review against the spec

- **Section 1:** `backend.ts` with exactly the listed exports (Task 1); layer rules "commands never imports browser.ts", "client.ts imports backend.ts" (Task 1). `subscribe()` is PR 6 and is not added.
- **Section 4, "Capability gate":** server checks `browser.cdpAvailable()` before a `requires: "cdp"` handler and answers with today's exact text; the `Browser.cdp()` check stays as backstop (Task 3).
- **Section 4, "`Browser` absorbs CDP details":** `getCookies`, `setCookie`, `deleteCookies`, `clearCookies` (Task 2); native history with the spec's own fallback clause honored (Task 4 keeps emulation behind `typeof`); the "if they differ" instruction is answered by the probe and recorded in the spec (Task 5).
- **Section 5:** two todos flipped, the press todo kept; e2e on both backends plus the compiled binary because `client.ts` changed (Tasks 4–5).
- **Contract:** no output string changes; the CDP error text is one constant asserted by `tests/cookie.test.ts`'s regex and the new handler test.
- **Type consistency:** `ViewLike`, `wrapView`, `NavTiming`, `NAV_TIMING`, `CDP_UNAVAILABLE`, `CdpOp`, `REQUIRES_CDP` are spelled identically across tasks. Test counts: 289 → 290 (T1) → 294 (T2) → 297 (T3) → 304 (T4).
- **Placeholder scan:** the `/* verbatim */` markers in Task 2 point at existing code to copy, not at code to invent.
