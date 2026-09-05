# Refactor PR 1: WebKit e2e coverage and the type gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any code moves, make the WebKit backend provably work end-to-end, add a typecheck gate, and fix the one WebKit bug the new tests expose (empty title on `open`).

**Architecture:** No structural change. `tsc` becomes a gate (`bun test` strips types and checks nothing). Existing e2e suites become backend-agnostic; a new WebKit scenario drives every WebKit-capable command against a local `Bun.serve` fixture; a differential test runs the same todo flow through `playwright-cli` and bowser and asserts bowser's refs are a subset of `playwright-cli`'s tree. CI gains a macOS WebKit job.

**Tech Stack:** Bun ≥ 1.3.12, `bun:test`, `Bun.serve`, `Bun.spawn`, TypeScript (devDependency added here), GitHub Actions `macos-latest`.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` (Sections 5 and 6, "Findings").

## Global Constraints

- Bun ≥ 1.3.12 (`engines.bun`; do not loosen).
- Zero runtime dependencies. `typescript` is a **dev**Dependency only, like `@types/bun`.
- Bun-native APIs: `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.serve`, `Bun.which`.
- Do not change CLI output, `--json` shapes, exit codes, snapshot YAML, `state.json`, or wire op names. The one intended output change: `open` on WebKit prints the real page title instead of `""`.
- Do not mock the daemon in e2e tests. E2E tests redirect `HOME` to a tmp dir in `beforeAll` and restore it in `afterAll`.
- `sessionsRoot()` and `bowserCacheRoot()` are call-time; never capture them at module scope.
- Every e2e `describe` is gated on `BOWSER_E2E=1` and skips otherwise, so `bun test` stays green on any machine.
- Commit message format: short imperative subject; body says why. End with the attribution trailer the session prescribes.
- Work on branch `refactor/1-webkit-e2e`, created from `refactor/maintainability-spec` (which carries the spec and this plan). If that branch has been merged, create from `main`.
- All commands below run from the bowser repo root: `/Users/anton/Personal/repos/bowser`. The shell resets its cwd after each call, so prefix commands with `cd /Users/anton/Personal/repos/bowser &&`.

---

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `package.json` | modify | add `typescript` devDependency and `typecheck` script |
| `.github/workflows/test.yml` | modify | typecheck step; rename Chromium job; new macOS WebKit job |
| `src/browser.ts` | modify | drop stale `@ts-expect-error`; type `toBunBackend`; add `resolveTitle` and `Browser.realTitle()` |
| `src/daemon.ts` | modify | type `DaemonClient.sock`; `state` op uses `realTitle()` |
| `tests/resolve-title.test.ts` | create | unit tests for `resolveTitle` |
| `tests/e2e.test.ts` | modify | backend-aware Chromium guard; label |
| `tests/e2e-todo.test.ts` | modify | same |
| `tests/fixtures/kitchen-sink.html` | create | page exercising every WebKit-capable interaction |
| `tests/e2e-webkit.test.ts` | create | the WebKit agent-loop scenario |
| `tests/e2e-compat.test.ts` | create | differential test against `playwright-cli` |
| `tests/layers.test.ts` | create | import-rule test, skeleton |
| `CLAUDE.md`, `README.md`, `CHANGELOG.md` | modify | test commands, Unreleased section |

---

### Task 1: Typecheck gate

**Files:**
- Modify: `package.json`
- Modify: `src/browser.ts:150-156` (the `new Bun.WebView(...)` call) and `src/browser.ts:90-99` (`toBunBackend`)
- Modify: `src/daemon.ts:276` (`private sock`)
- Modify: `.github/workflows/test.yml` (unit job)

**Interfaces:**
- Produces: `bun run typecheck` exits 0. `toBunBackend(b: Backend): BunBackend` where `BunBackend` is the `backend` option type of `Bun.WebView`'s constructor.

- [ ] **Step 1: Add the devDependency and script**

```bash
cd /Users/anton/Personal/repos/bowser && bun add -d typescript
```

Then edit `package.json` `scripts`:

```json
"scripts": {
  "start": "bun run src/cli.ts",
  "test": "bun test",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "build": "bun build src/cli.ts --compile --outfile dist/bowser"
}
```

- [ ] **Step 2: Run typecheck to see the three known failures**

Run: `cd /Users/anton/Personal/repos/bowser && bun run typecheck`
Expected: exit 1 with exactly these (line numbers approximate):

```
src/browser.ts(151,3): error TS2578: Unused '@ts-expect-error' directive.
src/browser.ts(154,5): error TS2322: Type 'unknown' is not assignable to type 'Backend | undefined'.
src/daemon.ts(329,16): error TS2339: Property 'end' does not exist on type 'Promise<Socket<unknown>>'.
```

If tsc reports anything else, stop and record it in the PR description; do not fix unrelated errors in this task.

- [ ] **Step 3: Fix `src/browser.ts`**

Replace the `toBunBackend` signature and remove the stale directive.

```ts
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
```

In `openBrowser`, delete the two comment lines starting `// @ts-expect-error Bun.WebView is available in Bun >= 1.3.12` so the call reads:

```ts
  const view = new Bun.WebView({
    backend: toBunBackend(spec),
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
  });
```

If tsc now complains that `stdout`/`stderr` or `argv` are not fields of the chrome object variant, open `node_modules/bun-types/bun.d.ts` at the `type Backend =` declaration (search for it) and use the field names it declares. Do not cast.

- [ ] **Step 4: Fix `src/daemon.ts`**

```ts
export class DaemonClient {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
```

Keep the existing `// @ts-expect-error Bun.connect unix option` above `Bun.connect({` — tsc did not flag it as unused, so it still suppresses a real error.

- [ ] **Step 5: Verify typecheck and tests are green**

Run: `cd /Users/anton/Personal/repos/bowser && bun run typecheck && bun test`
Expected: typecheck exits 0 with no output; all tests pass, e2e suites report as skipped.

- [ ] **Step 6: Add the CI step**

In `.github/workflows/test.yml`, unit job, after `- run: bun install --frozen-lockfile`:

```yaml
      - run: bun run typecheck
      - run: bun test
```

- [ ] **Step 7: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add package.json bun.lock src/browser.ts src/daemon.ts .github/workflows/test.yml && git commit -m "build: gate on tsc and fix the three errors it already finds

bun test strips types, so nothing checked them. tsc reports a stale
@ts-expect-error on Bun.WebView (bun-types 1.3.12 types it now), an
untyped backend option, and end() called on a Promise<Socket>."
```

---

### Task 2: WebKit reports the real title

**Files:**
- Create: `tests/resolve-title.test.ts`
- Modify: `src/browser.ts` (next to `resolveUrl`; `Browser` interface; `openBrowser` return object)
- Modify: `src/daemon.ts:135-140` (`state` op)

**Interfaces:**
- Produces: `resolveTitle(viewTitle: string, evalTitle: () => Promise<unknown>): Promise<string>` exported from `src/browser.ts`; `Browser.realTitle(): Promise<string>`. The `state` op result keeps the shape `{ url: string; title: string }`.

- [ ] **Step 1: Write the failing unit test**

`tests/resolve-title.test.ts`:

```ts
// Unit tests for the document.title fallback. On the webkit backend
// view.title is still "" when navigate() resolves, while the page's own
// document.title is already set. Mirrors tests/resolve-url.test.ts.
import { describe, expect, test } from "bun:test";
import { resolveTitle } from "../src/browser.ts";

describe("resolveTitle", () => {
  test("returns view.title unchanged when non-empty (no evaluate)", async () => {
    let called = false;
    const out = await resolveTitle("Kitchen Sink", async () => { called = true; return "x"; });
    expect(out).toBe("Kitchen Sink");
    expect(called).toBe(false);
  });

  test("falls back to document.title when view.title is empty", async () => {
    const out = await resolveTitle("", async () => "Bowser Todo");
    expect(out).toBe("Bowser Todo");
  });

  test("returns empty when evaluate throws", async () => {
    const out = await resolveTitle("", async () => { throw new Error("eval failed"); });
    expect(out).toBe("");
  });

  test("returns empty when evaluate yields a non-string", async () => {
    const out = await resolveTitle("", async () => undefined);
    expect(out).toBe("");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /Users/anton/Personal/repos/bowser && bun test tests/resolve-title.test.ts`
Expected: FAIL, `resolveTitle` is not exported.

- [ ] **Step 3: Implement**

In `src/browser.ts`, directly after `resolveUrl`:

```ts
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
```

In the `Browser` interface, after `realUrl(): Promise<string>;`:

```ts
  realTitle(): Promise<string>;
```

In the object returned by `openBrowser`, after the `realUrl:` line:

```ts
    realTitle: () => resolveTitle(view.title as string, () => view.evaluate("document.title")),
```

In `src/daemon.ts`, the `state` case:

```ts
        case "state":
          return {
            id: req.id,
            ok: true,
            result: { url: await browser.realUrl(), title: await browser.realTitle() },
          };
```

- [ ] **Step 4: Verify**

Run: `cd /Users/anton/Personal/repos/bowser && bun run typecheck && bun test`
Expected: all green.

- [ ] **Step 5: Verify against real WebKit by hand**

```bash
cd /Users/anton/Personal/repos/bowser && BOWSER_BACKEND=webkit bun src/cli.ts -s t open "data:text/html,<title>Hello</title><p>x</p>"; BOWSER_BACKEND=webkit bun src/cli.ts -s t close
```

Expected first line: `opened data:text/html,... "Hello"` (not `""`). The e2e assertion for this lands in Task 4.

- [ ] **Step 6: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add tests/resolve-title.test.ts src/browser.ts src/daemon.ts && git commit -m "fix: read the title from the page when WebKit's getter is still empty

On webkit view.title is \"\" when navigate() resolves, so open printed an
empty title. Same fallback shape as realUrl()."
```

---

### Task 3: Existing e2e suites run on whichever backend resolves

**Files:**
- Modify: `tests/e2e.test.ts:14-35`
- Modify: `tests/e2e-todo.test.ts:14-30`

**Interfaces:**
- Consumes: `resolveBackend()` and `detectChromium()` from `src/browser.ts`.

- [ ] **Step 1: Replace the guard in `tests/e2e.test.ts`**

Change the import line to:

```ts
import { detectChromium, isLikelyPng, resolveBackend } from "../src/browser.ts";
```

Replace the `describe` label and the detection block inside `beforeAll`:

```ts
runOrSkip("e2e: real browser (backend from resolveBackend)", () => {
```

```ts
  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-e2e-"));
    process.env.HOME = tmp;
    // Only the chrome backend needs a binary. On macOS with no explicit
    // Chromium this resolves to webkit and runs without one.
    if (resolveBackend().kind === "chrome" && !detectChromium()) {
      throw new Error(
        "BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found. " +
          "Install chromium-headless-shell, set BOWSER_CHROMIUM_PATH, or set BOWSER_BACKEND=webkit on macOS.",
      );
    }
  });
```

- [ ] **Step 2: Same in `tests/e2e-todo.test.ts`**

Import:

```ts
import { detectChromium, openBrowser, resolveBackend } from "../src/browser.ts";
```

Label: `runOrSkip("e2e: local todo app (backend from resolveBackend)", () => {`

Replace the first three lines of `beforeAll`:

```ts
  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-todo-"));
    process.env.HOME = tmp;
    if (resolveBackend().kind === "chrome" && !detectChromium()) {
      throw new Error(
        "BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found. " +
          "Install chromium-headless-shell, set BOWSER_CHROMIUM_PATH, or set BOWSER_BACKEND=webkit on macOS.",
      );
    }
```

(The `HOME` redirect now precedes the check, so the bowser cache under the real home does not count as "explicit Chromium". That matches what the daemon sees, since it inherits the redirected `HOME`.)

- [ ] **Step 3: Run both suites on WebKit, then on Chromium**

```bash
cd /Users/anton/Personal/repos/bowser && BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test tests/e2e.test.ts tests/e2e-todo.test.ts
```
Expected: 4 tests pass.

```bash
cd /Users/anton/Personal/repos/bowser && BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add tests/e2e.test.ts tests/e2e-todo.test.ts && git commit -m "test: let the e2e suites run on webkit without a Chromium binary

They demanded detectChromium() even when the daemon was going to use
webkit; now only the chrome backend requires a binary."
```

---

### Task 4: WebKit agent-loop scenario

**Files:**
- Create: `tests/fixtures/kitchen-sink.html`
- Create: `tests/e2e-webkit.test.ts`

**Interfaces:**
- Consumes: `cmdOpen`, `cmdGoto`, `cmdSnapshot`, `cmdClick`, `cmdFill`, `cmdType`, `cmdPress`, `cmdHover`, `cmdSelect`, `cmdCheck`, `cmdUncheck`, `cmdResize`, `cmdHistory`, `cmdEval`, `cmdRunCode`, `cmdList`, `cmdClose`, `cmdLocalStorage*`, `cmdSessionStorage*` from `src/commands.ts` (signatures as they exist today); `loadState` from `src/state.ts`.

- [ ] **Step 1: Write the fixture**

`tests/fixtures/kitchen-sink.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Kitchen Sink</title>
</head>
<body>
  <main>
    <h1>Kitchen Sink</h1>
    <form id="f">
      <input id="name" type="text" aria-label="Name" placeholder="Your name" autocomplete="off" />
      <select id="color" aria-label="Color">
        <option value="red">red</option>
        <option value="blue">blue</option>
      </select>
      <input id="agree" type="checkbox" aria-label="Agree" />
      <button id="submit" type="submit">Submit</button>
    </form>
    <p id="submitted"></p>
    <button id="hoverme" type="button">Hover me</button>
    <p id="hovered"></p>
    <p id="keys"></p>
    <p id="size"></p>
    <a id="two" href="/two">Page two</a>
  </main>
  <script>
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("submitted").textContent = "submitted:" + document.getElementById("name").value;
    });
    document.getElementById("color").addEventListener("change", (e) => {
      document.getElementById("submitted").textContent = "color:" + e.target.value;
    });
    document.getElementById("hoverme").addEventListener("mouseover", () => {
      document.getElementById("hovered").textContent = "hovered";
    });
    document.addEventListener("keydown", (e) => {
      document.getElementById("keys").textContent += e.key + ";";
    });
    function size() { document.getElementById("size").textContent = innerWidth + "x" + innerHeight; }
    addEventListener("resize", size);
    size();
  </script>
</body>
</html>
```

- [ ] **Step 2: Write the test file**

`tests/e2e-webkit.test.ts`:

```ts
// End-to-end on the WebKit backend: every command that works without CDP,
// driven the way an agent would drive it (snapshot → ref → act → read back).
// Page state is verified with `eval` so a passing test proves the DOM
// changed, not just that the command returned.
//
// macOS only (webkit is a macOS backend). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-webkit.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cmdCheck, cmdClick, cmdClose, cmdEval, cmdFill, cmdGoto, cmdHistory, cmdHover,
  cmdList, cmdLocalStorageClear, cmdLocalStorageDelete, cmdLocalStorageGet,
  cmdLocalStorageList, cmdLocalStorageSet, cmdOpen, cmdPress, cmdResize,
  cmdRunCode, cmdSelect, cmdSessionStorageClear, cmdSessionStorageGet,
  cmdSessionStorageList, cmdSessionStorageSet, cmdSnapshot, cmdType, cmdUncheck,
  type CommandContext,
} from "../src/commands.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: WebKit agent loop", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origBackend: string | undefined;
  let server: { stop: () => void } | undefined;
  let base: string;

  const session = "wk";
  const ctx: CommandContext = { session, json: true };
  const text: CommandContext = { session, json: false };

  beforeAll(async () => {
    origHome = process.env.HOME;
    origBackend = process.env.BOWSER_BACKEND;
    tmp = await mkdtemp(join(tmpdir(), "bowser-webkit-"));
    process.env.HOME = tmp;
    // Force webkit even on a machine with `bowser install`ed Chromium. The
    // daemon inherits the live env, so this reaches it.
    process.env.BOWSER_BACKEND = "webkit";

    const sink = await readFile(join(import.meta.dir, "fixtures/kitchen-sink.html"), "utf8");
    const two = `<!doctype html><html><head><title>Page Two</title></head><body><main><h1>Two</h1><a href="/">Back home</a></main></body></html>`;
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        const body = new URL(req.url).pathname === "/two" ? two : sink;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    server = { stop: () => s.stop(true) };
    base = s.url.toString(); // ends with "/"
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origBackend === undefined) delete process.env.BOWSER_BACKEND;
    else process.env.BOWSER_BACKEND = origBackend;
    await rm(tmp, { recursive: true, force: true });
  });

  /** Ref id for the most recent snapshot's element with this accessible name. */
  async function refNamed(name: string): Promise<string> {
    const state = await loadState(session);
    const r = state?.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in last snapshot`);
    return r.id;
  }

  /** Evaluate an expression in the page and return its printed result. */
  const evalText = (expr: string) => cmdEval(text, expr);

  /** Navigation settles asynchronously; poll until `expr` prints `want`. */
  async function waitForEval(expr: string, want: string, ms = 5000): Promise<void> {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < ms) {
      last = await evalText(expr);
      if (last === want) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${expr} === ${JSON.stringify(want)}; last was ${JSON.stringify(last)}`);
  }

  test("open reports the real title (WebKit title fallback)", async () => {
    const out = JSON.parse(await cmdOpen(ctx, base)) as { ok: boolean; url: string; title: string };
    expect(out.ok).toBe(true);
    expect(out.url).toBe(base);
    expect(out.title).toBe("Kitchen Sink");
  }, 60_000);

  test("snapshot lists every interactive element with a ref", async () => {
    const yaml = await cmdSnapshot(text);
    for (const line of [
      'textbox "Name": [ref=',
      'combobox "Color": [ref=',
      'checkbox "Agree": [ref=',
      'button "Submit": [ref=',
      'button "Hover me": [ref=',
      'link "Page two": [ref=',
    ]) {
      expect(yaml).toContain(line);
    }
  }, 60_000);

  test("fill, type and press Enter submit the form", async () => {
    await cmdSnapshot(text);
    const name = await refNamed("Name");
    await cmdFill(ctx, name, "Ada");
    await cmdType(ctx, " Lovelace");
    expect(await evalText("document.getElementById('name').value")).toBe("Ada Lovelace");
    await cmdPress(ctx, "Enter");
    await waitForEval("document.getElementById('submitted').textContent", "submitted:Ada Lovelace");
    expect(await evalText("document.getElementById('keys').textContent")).toContain("Enter;");
  }, 60_000);

  test("select fires change with the chosen value", async () => {
    await cmdSnapshot(text);
    await cmdSelect(ctx, await refNamed("Color"), "blue");
    expect(await evalText("document.getElementById('color').value")).toBe("blue");
    expect(await evalText("document.getElementById('submitted').textContent")).toBe("color:blue");
  }, 60_000);

  test("check and uncheck toggle the checkbox", async () => {
    await cmdSnapshot(text);
    const agree = await refNamed("Agree");
    await cmdCheck(ctx, agree);
    expect(await evalText("String(document.getElementById('agree').checked)")).toBe("true");
    await cmdUncheck(ctx, agree);
    expect(await evalText("String(document.getElementById('agree').checked)")).toBe("false");
  }, 60_000);

  test("hover fires mouseover", async () => {
    await cmdSnapshot(text);
    await cmdHover(ctx, await refNamed("Hover me"));
    expect(await evalText("document.getElementById('hovered').textContent")).toBe("hovered");
  }, 60_000);

  test("resize changes the viewport the page sees", async () => {
    const out = JSON.parse(await cmdResize(ctx, "900", "700")) as { ok: boolean };
    expect(out.ok).toBe(true);
    await waitForEval("innerWidth + 'x' + innerHeight", "900x700");
  }, 60_000);

  test("click a link, then go-back, go-forward, reload, goto", async () => {
    await cmdSnapshot(text);
    const out = JSON.parse(await cmdClick(ctx, await refNamed("Page two"))) as { url: string };
    await waitForEval("document.title", "Page Two");
    expect(out.url.endsWith("/two") || (await evalText("location.pathname")) === "/two").toBe(true);

    await cmdHistory(ctx, "back");
    await waitForEval("document.title", "Kitchen Sink");

    await cmdHistory(ctx, "forward");
    await waitForEval("document.title", "Page Two");

    const reloaded = JSON.parse(await cmdHistory(ctx, "reload")) as { ok: boolean };
    expect(reloaded.ok).toBe(true);
    await waitForEval("document.title", "Page Two");

    const gone = JSON.parse(await cmdGoto(ctx, base)) as { url: string };
    expect(gone.url).toBe(base);
    await waitForEval("document.title", "Kitchen Sink");
  }, 90_000);

  test("localStorage round-trip", async () => {
    await cmdLocalStorageSet(ctx, "k1", "v1");
    await cmdLocalStorageSet(ctx, "k2", "v2");
    expect(await cmdLocalStorageGet(text, "k1")).toBe("v1");
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({ k1: "v1", k2: "v2" });
    await cmdLocalStorageDelete(ctx, "k1");
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({ k2: "v2" });
    await cmdLocalStorageClear(ctx);
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({});
  }, 60_000);

  test("sessionStorage round-trip", async () => {
    await cmdSessionStorageSet(ctx, "s1", "x");
    expect(await cmdSessionStorageGet(text, "s1")).toBe("x");
    expect(JSON.parse(await cmdSessionStorageList(ctx))).toEqual({ s1: "x" });
    await cmdSessionStorageClear(ctx);
    expect(JSON.parse(await cmdSessionStorageList(ctx))).toEqual({});
  }, 60_000);

  test("eval and run-code return page values", async () => {
    expect(await evalText("1 + 1")).toBe("2");
    expect(await cmdRunCode(text, "const t = document.title; return t.toUpperCase();")).toBe("KITCHEN SINK");
  }, 60_000);

  test("list shows the session; close --all ends it", async () => {
    expect(JSON.parse(await cmdList(ctx)) as string[]).toContain(session);
    const out = JSON.parse(await cmdClose(ctx, { all: true })) as { ok: boolean; closed: string[] };
    expect(out.ok).toBe(true);
    expect(out.closed).toContain(session);
    const after = await loadState(session);
    expect(after?.url).toBe("");
  }, 60_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd /Users/anton/Personal/repos/bowser && BOWSER_E2E=1 bun test tests/e2e-webkit.test.ts`
Expected: 12 tests pass.

If **only** the history test fails or flakes: that is the open question in the spec (Section 4, native `goBack` vs `history.back()` emulation). Do not change `browser.ts` here. Record the exact failure in the PR description as input to PR 3, and keep the test as written; if it fails deterministically, mark that single test `test.todo` with the failure text in its name so the suite stays green and the gap stays visible.

If anything else fails, it is a real WebKit defect this PR exists to find. Stop, report it, and decide with the owner whether it is fixed here (one-liner, like the title) or filed as an issue.

- [ ] **Step 4: Run the whole suite to check nothing leaked**

Run: `cd /Users/anton/Personal/repos/bowser && bun run typecheck && bun test && BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test`
Expected: green; no stray daemon processes afterwards (`pgrep -fl daemon-main` prints nothing).

- [ ] **Step 5: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add tests/fixtures/kitchen-sink.html tests/e2e-webkit.test.ts && git commit -m "test: drive every WebKit-capable command end-to-end

One agent-loop scenario against a local fixture; page state is read back
with eval so a pass proves the DOM changed. Also the e2e check for the
WebKit title fix."
```

---

### Task 5: Differential test against `playwright-cli`

**Files:**
- Create: `tests/e2e-compat.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/todo-app.html`; `cmdOpen`, `cmdSnapshot`, `cmdFill`, `cmdClick`, `cmdClose` from `src/commands.ts`; `loadState` from `src/state.ts`; the `playwright-cli` binary via `Bun.which`.

Local prerequisite (one-time, not automated): `playwright-cli install-browser webkit`. Without it the test skips with a warning naming that command.

- [ ] **Step 1: Write the test**

`tests/e2e-compat.test.ts`:

```ts
// Differential test: the same todo flow through playwright-cli (WebKit) and
// bowser (WebKit) against the same fixture. playwright-cli 0.1.x prints the
// full accessibility tree, bowser prints interactive elements only, so the
// assertion is subset, not equality: every (role, name) bowser reports must
// appear in playwright-cli's tree, before and after the flow.
//
// Skips unless BOWSER_E2E=1, on macOS, with playwright-cli in $PATH and its
// WebKit installed (`playwright-cli install-browser webkit`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClick, cmdClose, cmdFill, cmdOpen, cmdSnapshot, type CommandContext } from "../src/commands.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const PW = Bun.which("playwright-cli");
const runOrSkip = E2E && process.platform === "darwin" && PW ? describe : describe.skip;

type Entry = { role: string; name: string };

/** (role, name) pairs from playwright-cli's yaml fence. Nodes without a
 *  quoted name (generic containers) are ignored. */
function parsePlaywright(stdout: string): Entry[] {
  const m = stdout.match(/```yaml\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no yaml fence in playwright-cli output:\n${stdout}`);
  const out: Entry[] = [];
  for (const line of m[1]!.split("\n")) {
    const r = line.match(/^\s*- (\S+) "([^"]*)"/);
    if (r) out.push({ role: r[1]!, name: r[2]! });
  }
  return out;
}

/** (role, name) pairs for bowser's leaf refs. */
function parseBowser(yaml: string): Entry[] {
  const out: Entry[] = [];
  for (const line of yaml.split("\n")) {
    const r = line.match(/^\s*- (\S+) "([^"]*)": \[ref=e\d+\]/);
    if (r) out.push({ role: r[1]!, name: r[2]! });
  }
  return out;
}

function missingFrom(sub: Entry[], sup: Entry[]): Entry[] {
  const key = (e: Entry) => `${e.role} ${e.name}`;
  const have = new Set(sup.map(key));
  return sub.filter((e) => !have.has(key(e)));
}

runOrSkip("e2e: bowser vs playwright-cli on WebKit", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origBackend: string | undefined;
  let server: { stop: () => void } | undefined;
  let base: string;
  let pwReady = false;

  const session = "compat";
  const ctx: CommandContext = { session, json: true };
  const text: CommandContext = { session, json: false };
  const pwSession = "bowser-compat";

  /** Run playwright-cli in the tmp dir (it writes .playwright-cli/ to cwd). */
  async function pw(...args: string[]): Promise<{ code: number; out: string }> {
    const p = Bun.spawn({
      cmd: [PW!, `-s=${pwSession}`, ...args],
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: origHome ?? process.env.HOME! },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: out + err };
  }

  /** playwright-cli ref for the first node with this role and name. */
  function pwRef(stdout: string, role: string, name: string): string {
    const m = stdout.match(/```yaml\n([\s\S]*?)\n```/);
    const re = new RegExp(`^\\s*- ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\n]*\\[ref=(e\\d+)\\]`, "m");
    const r = (m?.[1] ?? "").match(re);
    if (!r) throw new Error(`playwright-cli: no ${role} "${name}" in:\n${stdout}`);
    return r[1]!;
  }

  async function bowserRef(name: string): Promise<string> {
    const s = await loadState(session);
    const r = s?.refs.find((x) => x.name === name);
    if (!r) throw new Error(`bowser: no ref named ${JSON.stringify(name)}`);
    return r.id;
  }

  beforeAll(async () => {
    origHome = process.env.HOME;
    origBackend = process.env.BOWSER_BACKEND;
    tmp = await mkdtemp(join(tmpdir(), "bowser-compat-"));
    process.env.BOWSER_BACKEND = "webkit";

    const html = await readFile(join(import.meta.dir, "fixtures/todo-app.html"), "utf8");
    const s = Bun.serve({
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    server = { stop: () => s.stop(true) };
    base = s.url.toString();

    // playwright-cli keeps its own daemon; open it with the real HOME (its
    // browser cache lives there) before bowser's HOME is redirected.
    const opened = await pw("open", "--browser=webkit", base);
    if (opened.code !== 0) {
      if (/is not installed/.test(opened.out)) {
        console.warn("e2e-compat: playwright-cli has no WebKit; run `playwright-cli install-browser webkit`. Skipping.");
      } else {
        throw new Error(`playwright-cli open failed:\n${opened.out}`);
      }
    } else {
      pwReady = true;
    }

    process.env.HOME = tmp;
    await cmdOpen(ctx, base);
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    if (pwReady) { try { await pw("close"); } catch {} }
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origBackend === undefined) delete process.env.BOWSER_BACKEND;
    else process.env.BOWSER_BACKEND = origBackend;
    await rm(tmp, { recursive: true, force: true });
  });

  test("bowser's refs are a subset of playwright-cli's tree on the fresh page", async () => {
    if (!pwReady) return;
    const pwOut = (await pw("snapshot")).out;
    const bowserOut = await cmdSnapshot(text);
    const missing = missingFrom(parseBowser(bowserOut), parsePlaywright(pwOut));
    expect(missing, `bowser refs absent from playwright-cli:\n${JSON.stringify(missing)}\n\nbowser:\n${bowserOut}\n\nplaywright-cli:\n${pwOut}`).toEqual([]);
  }, 90_000);

  test("after the same fill+click flow both tools see the new todos", async () => {
    if (!pwReady) return;
    for (const todo of ["buy milk", "write tests"]) {
      // playwright-cli: re-snapshot before each action, refs can shift.
      let snap = (await pw("snapshot")).out;
      const fill = await pw("fill", pwRef(snap, "textbox", "New todo"), todo);
      expect(fill.code, fill.out).toBe(0);
      snap = (await pw("snapshot")).out;
      const click = await pw("click", pwRef(snap, "button", "Add"));
      expect(click.code, click.out).toBe(0);

      // bowser: same dance.
      await cmdSnapshot(text);
      await cmdFill(ctx, await bowserRef("New todo"), todo);
      await cmdSnapshot(text);
      await cmdClick(ctx, await bowserRef("Add"));
    }

    const pwOut = (await pw("snapshot")).out;
    const bowserOut = await cmdSnapshot(text);
    const b = parseBowser(bowserOut);
    expect(b).toContainEqual({ role: "checkbox", name: "Toggle buy milk" });
    expect(b).toContainEqual({ role: "checkbox", name: "Toggle write tests" });
    const missing = missingFrom(b, parsePlaywright(pwOut));
    expect(missing, `bowser refs absent from playwright-cli:\n${JSON.stringify(missing)}\n\nbowser:\n${bowserOut}\n\nplaywright-cli:\n${pwOut}`).toEqual([]);
  }, 180_000);
});
```

- [ ] **Step 2: Install playwright-cli's WebKit once (owner's machine), then run**

```bash
playwright-cli install-browser webkit
cd /Users/anton/Personal/repos/bowser && BOWSER_E2E=1 bun test tests/e2e-compat.test.ts
```
Expected: 2 tests pass. Without the WebKit install, expected: the suite runs, prints the warning, and both tests pass trivially (they return early). Confirm the skip path once by temporarily running with `PATH` stripped of `playwright-cli`:

```bash
cd /Users/anton/Personal/repos/bowser && PATH=/usr/bin:/bin BOWSER_E2E=1 ~/.bun/bin/bun test tests/e2e-compat.test.ts
```
Expected: suite reported as skipped.

- [ ] **Step 3: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add tests/e2e-compat.test.ts && git commit -m "test: diff bowser against playwright-cli on the todo flow

Subset assertion: every ref bowser reports must exist in playwright-cli's
full accessibility tree, before and after fill+click. Skips without
playwright-cli or its WebKit."
```

---

### Task 6: Layer test skeleton

**Files:**
- Create: `tests/layers.test.ts`

**Interfaces:**
- Produces: a `RULES` array later PRs extend. Each rule is `{ name, violates(file, text) => boolean }`.

- [ ] **Step 1: Write the test with the rules that hold today**

`tests/layers.test.ts`:

```ts
// Import-rule test. Cheap stand-in for a dependency linter: reads every
// src/**/*.ts and checks the layering rules from the maintainability spec
// (docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md,
// Section 1). Only rules that hold today are listed; each refactor PR adds
// the rules its layout makes true.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Module specifiers of value imports (type-only imports are ignored). */
function valueImports(text: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

interface Rule {
  name: string;
  /** True when this file breaks the rule. `file` is repo-relative. */
  violates(file: string, text: string): boolean;
}

const RULES: Rule[] = [
  {
    name: "only src/browser.ts mentions Bun.WebView",
    violates: (file, text) => file !== "src/browser.ts" && /\bBun\.WebView\b/.test(text),
  },
  {
    name: "only src/daemon.ts calls openBrowser",
    violates: (file, text) => file !== "src/daemon.ts" && file !== "src/browser.ts" && /\bopenBrowser\s*\(/.test(text),
  },
  {
    name: "snapshot.ts, serialize.ts and socket-write.ts have no value imports from src",
    violates: (file, text) =>
      ["src/snapshot.ts", "src/serialize.ts", "src/socket-write.ts"].includes(file) &&
      valueImports(text).some((s) => s.startsWith("./") || s.startsWith("../")),
  },
];

describe("src layering rules", () => {
  const files = sources(SRC).map((p) => ({ file: relative(ROOT, p), text: readFileSync(p, "utf8") }));
  for (const rule of RULES) {
    test(rule.name, () => {
      const violators = files.filter((f) => rule.violates(f.file, f.text)).map((f) => f.file);
      expect(violators).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd /Users/anton/Personal/repos/bowser && bun test tests/layers.test.ts`
Expected: 3 pass. If a rule fails, the rule is wrong about today's code, not the code: fix the rule to state what holds and note the intended future rule in a comment.

- [ ] **Step 3: Commit**

```bash
cd /Users/anton/Personal/repos/bowser && git add tests/layers.test.ts && git commit -m "test: pin the import rules the refactor will extend"
```

---

### Task 7: CI, docs, changelog

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `CLAUDE.md` ("Build & test")
- Modify: `README.md` (testing block near line 185)
- Modify: `CHANGELOG.md` (new `[Unreleased]` section)

- [ ] **Step 1: Rename the Chromium job and add the WebKit job**

In `test.yml`, change the existing e2e job's `name:` to `e2e (Chromium, Linux)`. Then append:

```yaml
  e2e-webkit:
    name: e2e (WebKit, macOS)
    runs-on: macos-latest
    needs: unit
    env:
      BOWSER_E2E: "1"
      BOWSER_BACKEND: webkit
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ">=1.3.12"
      - run: bun install --frozen-lockfile
      - name: E2E on WebKit
        # e2e-compat skips here: the runner has no playwright-cli.
        run: bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-webkit.test.ts tests/e2e-compat.test.ts
      - name: E2E - compiled binary daemon + screenshot (WebKit)
        # Same guard as the Linux job. macOS ships no `timeout`; perl's alarm
        # survives exec, so it bounds the child the same way.
        run: |
          bun build src/cli.ts --compile --outfile dist/bowser
          t() { perl -e 'alarm shift; exec @ARGV' -- 60 "$@"; }
          t ./dist/bowser open "data:text/html,<h1>ci</h1>" --session ci-smoke
          t ./dist/bowser screenshot --session ci-smoke --filename /tmp/ci-smoke.png
          t ./dist/bowser close --session ci-smoke
          file /tmp/ci-smoke.png | grep -q "PNG image data"
```

- [ ] **Step 2: Update CLAUDE.md "Build & test"**

Replace the fenced block that starts `bun install` with:

```bash
bun install
bun build src/cli.ts --compile --outfile dist/bowser
# release.yml cross-compiles one binary per target, passing a single
# --target=<t> each: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64

bun run typecheck                              # tsc; bun test strips types and checks nothing
bun test                                       # unit + command tests, fake daemon, no browser
BOWSER_E2E=1 bun test                          # + offline e2e on whichever backend resolves (webkit on macOS)
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test    # + the WebKit agent-loop scenario (macOS)
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search; brittle)
```

After that block add one paragraph:

```markdown
`tests/e2e-compat.test.ts` diffs bowser against `playwright-cli` on WebKit and
skips unless `playwright-cli` is in `$PATH` with its WebKit installed
(`playwright-cli install-browser webkit`). It asserts bowser's refs are a
subset of `playwright-cli`'s tree; the formats themselves differ on purpose
until the snapshot-parity task (see the 2026-09-05 refactor spec, "Findings").
```

- [ ] **Step 3: Update README testing block**

Replace the three `bun test` lines near line 185 with:

```bash
bun run typecheck                              # tsc
bun test                                       # unit + command tests with a fake daemon
BOWSER_E2E=1 bun test                          # + end-to-end on the resolved backend (WebKit on macOS, Chromium elsewhere)
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search)
```

- [ ] **Step 4: CHANGELOG**

Insert above `## [0.5.0] — 2026-06-15`:

```markdown
## [Unreleased]

### Fixed

- **WebKit: `open` printed an empty title.** `Bun.WebView`'s `title` getter is still empty when
  `navigate()` resolves on the webkit backend; the daemon now reads `document.title` from the page
  when the getter is empty, the same fallback `realUrl()` uses for the URL.

### Changed

- **Type checking is a gate.** `bun run typecheck` (tsc) runs in CI; `bun test` strips types and
  never checked them. Three latent type errors fixed.
- **WebKit is tested end-to-end.** A macOS CI job runs the e2e suites on WebKit, including a
  new agent-loop scenario covering every non-CDP command, and a differential test against
  `playwright-cli` (skipped when it is not installed).
```

- [ ] **Step 5: Full local gate**

```bash
cd /Users/anton/Personal/repos/bowser && bun run typecheck && bun test && BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test && BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
```
Expected: all green.

- [ ] **Step 6: Commit, push, open the PR**

```bash
cd /Users/anton/Personal/repos/bowser && git add .github/workflows/test.yml CLAUDE.md README.md CHANGELOG.md && git commit -m "ci: run the e2e suites on WebKit under macOS

Adds the macOS job, the typecheck step, and documents the new test
commands."
git push -u origin refactor/1-webkit-e2e
gh pr create --title "Refactor PR 1: WebKit e2e coverage and the type gate" --body-file - <<'EOF'
First PR of the maintainability series (spec: docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md).

- `bun run typecheck` gate; fixes the three errors tsc already reported.
- WebKit `open` printed an empty title: fixed via a `document.title` fallback.
- Existing e2e suites no longer demand a Chromium binary when the backend is WebKit.
- New `tests/e2e-webkit.test.ts`: every non-CDP command end-to-end on WebKit.
- New `tests/e2e-compat.test.ts`: bowser refs ⊆ playwright-cli tree on the todo flow.
- New `tests/layers.test.ts`: import rules, to be extended by later PRs.
- CI: `e2e (WebKit, macOS)` job with the compiled-binary smoke.

Findings for later PRs (fill in from the runs): history-navigation timing on WebKit (spec Section 4 open question).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Wait for CI. Both e2e jobs and the typecheck step must be green before this PR is called done.

---

## Self-review against the spec

- **Section 5, PR 1 bullets → tasks:** typecheck gate (Task 1), WebKit title (Task 2), backend-agnostic suites (Task 3), `e2e-webkit` (Task 4), `e2e-compat` (Task 5), macOS CI job with compiled smoke (Task 7), layer skeleton (Task 6). `OP_META` test deliberately absent (PR 2).
- **Per-PR gate** (typecheck, unit, WebKit e2e, Chromium e2e, compiled binary): Task 7 Step 5 plus the CI smoke.
- **Contract:** no output changes except the WebKit title; snapshot YAML untouched; `e2e-compat` asserts subset, not equality, per "Findings".
- **Names used consistently:** `resolveTitle`/`realTitle` (Tasks 2, 4), `refNamed`/`bowserRef`, `waitForEval`, `RULES`/`violates`.
