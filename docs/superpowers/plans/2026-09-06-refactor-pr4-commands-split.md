# Refactor PR 4: commands split, context helpers, page-scripts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/commands.ts` (822 lines) becomes `src/commands/*.ts` split by domain, every JavaScript snippet injected into the page lives in `src/page-scripts.ts`, and the four things every command repeats (`withClient`, `loadRef`, the `ctx.json ? JSON.stringify(...) : text` reply, and the "save url/title after an action" state sync) live in `src/commands/context.ts`.

**Architecture:** Pure moves first, then the one new helper pair. Task 1 creates `page-scripts.ts` and repoints `browser.ts` and `commands.ts` at it; a layer rule then makes it the only file allowed to build an IIFE string. Task 2 moves every command into its domain module verbatim, deletes `commands.ts`, and repoints `cli.ts` and the tests. Task 3 introduces `reply()` and `syncState()` and rewrites the call sites mechanically, with byte-identical output. Task 4 is layer rules, docs, the full gate and the PR. No output string, `--json` shape, wire op or exit code changes.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2 (`bun run typecheck` is the gate), bun:test. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` — Section 1 (layout: `commands/*`, `page-scripts.ts`, `context.ts` helpers; layer rules), "The contract" (wording may move toward `playwright-cli` in PR 4; this plan chooses not to, so no CHANGELOG output entries), Section 6 row 4.

## Global Constraints

- Zero runtime dependencies. Wire format, op names, CLI output strings, `--json` shapes and exit codes are unchanged. `tests/commands.test.ts`, `tests/cookie.test.ts`, `tests/state-storage.test.ts` and every e2e suite change only their import lines.
- `src/commands.ts` is deleted; there is no barrel. Each consumer imports from the module that owns the function (spec Section 1). `cli.ts`'s `run()` switch stays until PR 5 replaces it with the registry.
- Layer rules after this PR: `src/commands/*` has no value import of `browser.ts` or `daemon/server.ts`; `src/commands/install.ts` imports `backend.ts`; `page-scripts.ts` imports nothing from `src/`; only `src/page-scripts.ts` contains an IIFE string (`(() =>`); `daemon/client.ts` still does not import `browser.ts`.
- `JSON.stringify(selector)` quoting in every injected script is preserved byte-for-byte (CLAUDE.md gotcha).
- Every commit carries the trailer lines `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj`.
- Per-task gate: `bun run typecheck && bun test` (309 pass at the start). Task 4 also runs the WebKit and Chromium e2e suites and the compiled-binary smoke, because `cli.ts` changes.

---

### Task 1: `src/page-scripts.ts` — every injected snippet in one file

**Files:**
- Create: `src/page-scripts.ts`
- Modify: `src/snapshot.ts` (delete `SNAPSHOT_SCRIPT` and its comment; keep `SnapshotResult`, `toYaml`, `toJson`)
- Modify: `src/browser.ts` (`hover`, `select`, `setChecked` call the builders)
- Modify: `src/commands.ts` (fill, storage, run-code, state-save, state-load use the builders)
- Create: `tests/page-scripts.test.ts`
- Modify: `tests/layers.test.ts` (rule 3 list; new IIFE rule)

**Interfaces:**
- Produces, all exported from `src/page-scripts.ts`: `SNAPSHOT_SCRIPT: string` (moved verbatim); `hoverScript(selector: string): string`; `selectScript(selector: string, value: string): string`; `setCheckedScript(selector: string, checked: boolean): string`; `clearForFillScript(selector: string): string`; `type StorageArea = "localStorage" | "sessionStorage"`; `storageScript(area: StorageArea, body: string): string` (the try/catch wrapper, moved); `storageListScript(area)`, `storageGetScript(area, key)`, `storageSetScript(area, key, value)`, `storageDeleteScript(area, key)`, `storageClearScript(area)`, `storageRestoreScript(area, entries: Array<{ name: string; value: string }>)`; `runCodeScript(code: string): string`.

- [ ] **Step 1: Failing test**

`tests/page-scripts.test.ts`:

```ts
// The one rule for page scripts: anything from the user is embedded via
// JSON.stringify, so a selector or key with quotes cannot break out of the
// string. These pin that for every builder that takes user input.
import { describe, expect, test } from "bun:test";
import {
  clearForFillScript, hoverScript, runCodeScript, selectScript, setCheckedScript,
  storageDeleteScript, storageGetScript, storageRestoreScript, storageSetScript, storageScript,
} from "../src/page-scripts.ts";

const nasty = `a"b'c\\d`;
const quoted = JSON.stringify(nasty);

describe("page scripts quote their inputs", () => {
  test("selector builders embed JSON.stringify(selector)", () => {
    for (const s of [hoverScript(nasty), selectScript(nasty, "v"), setCheckedScript(nasty, true), clearForFillScript(nasty)]) {
      expect(s).toContain(`document.querySelector(${quoted})`);
    }
    expect(selectScript("#s", nasty)).toContain(`el.value = ${quoted};`);
  });

  test("storage builders embed JSON.stringify(key) and wrap in the area's try/catch", () => {
    expect(storageGetScript("localStorage", nasty)).toContain(`localStorage.getItem(${quoted})`);
    expect(storageSetScript("sessionStorage", nasty, nasty)).toContain(`sessionStorage.setItem(${quoted}, ${quoted})`);
    expect(storageDeleteScript("localStorage", nasty)).toContain(`localStorage.removeItem(${quoted})`);
    expect(storageRestoreScript("localStorage", [{ name: nasty, value: "1" }])).toContain(`localStorage.setItem(${quoted}, "1");`);
    expect(storageScript("localStorage", "x")).toBe("(() => { try { x } catch (e) { throw new Error('localStorage: ' + (e && e.message || e)); } })()");
  });

  test("run-code wraps the body in an IIFE", () => {
    expect(runCodeScript("return 1;")).toBe("(() => { return 1; })()");
  });
});
```

Run: `bun test tests/page-scripts.test.ts` → fails to import.

- [ ] **Step 2: Write `src/page-scripts.ts`**

Header, then the builders. Every string body is copied from where it lives today; the table says where:

| Builder | Copy from | Notes |
| --- | --- | --- |
| `SNAPSHOT_SCRIPT` | `src/snapshot.ts` lines from `// This function is serialized…` through the closing `})\`;` | verbatim, including the comment block above it |
| `hoverScript` | `src/browser.ts` `hover` body: the template literal passed to `view.evaluate` | function returns that literal |
| `selectScript` | `select` body | same |
| `setCheckedScript` | `setChecked` body | `${checked}` stays a boolean interpolation |
| `clearForFillScript` | `src/commands.ts` `cmdFill`'s `clearExpr` | same |
| `storageScript` | `src/commands.ts` `storageScript` | moved as is |
| `storageListScript(area)` | body string in `storageList` | `storageScript(area, \`const o = {}; for (let i = 0; i < ${area}.length; i++) { const k = ${area}.key(i); o[k] = ${area}.getItem(k); } return o;\`)` — this is also `LOCALSTORAGE_DUMP` for `localStorage`; `cmdStateSave` uses `storageListScript("localStorage")` and `LOCALSTORAGE_DUMP` is deleted |
| `storageGetScript`, `storageSetScript`, `storageDeleteScript`, `storageClearScript` | the bodies in `storageGet`/`storageSet`/`storageDelete`/`storageClear` | each wraps with `storageScript(area, …)` |
| `storageRestoreScript(area, entries)` | `cmdStateLoad`'s `sets` join | `storageScript(area, entries.map((e) => \`${area}.setItem(${JSON.stringify(e.name)}, ${JSON.stringify(e.value)});\`).join(" "))` |
| `runCodeScript(code)` | `cmdRunCode`'s `wrapped` | `\`(() => { ${code} })()\`` |

Header comment:

```ts
// Every JavaScript snippet bowser injects into the page. Builders take user
// input (selectors, keys, values) and embed it with JSON.stringify, which is
// what keeps a selector with quotes from breaking out of the string. This
// file imports nothing from src/ and is the only one allowed to build an
// IIFE string (tests/layers.test.ts).
```

- [ ] **Step 3: Repoint the callers**

- `src/snapshot.ts`: delete `SNAPSHOT_SCRIPT` and the comment block that introduces it; update the file header's mention if it says the script lives here ("Runs inside the page via view.evaluate()…" stays true of the script, so reword to "The script itself lives in page-scripts.ts").
- `src/browser.ts`: `import { hoverScript, selectScript, setCheckedScript } from "./page-scripts.ts";` and `hover: async (selector) => { await view.evaluate(hoverScript(selector)); }`, likewise `select`, `setChecked`.
- `src/commands.ts`: import `SNAPSHOT_SCRIPT` from `./page-scripts.ts` instead of `./snapshot.ts`; `cmdFill` uses `clearForFillScript(target.selector)`; the five `storage*` helpers use their builders (delete the local `storageScript`); `cmdRunCode` uses `runCodeScript(code)`; `cmdStateSave` uses `storageListScript("localStorage")` (delete `LOCALSTORAGE_DUMP`); `cmdStateLoad` uses `storageRestoreScript("localStorage", o.localStorage)` when `o.localStorage.length > 0` (today: `if (sets)` — an empty entries array gave an empty `sets` string and no evaluate; keep that: only evaluate when the array is non-empty).

- [ ] **Step 4: Layer rules**

In `tests/layers.test.ts`, rule 3's list gains `"src/page-scripts.ts"` and its name becomes `"backend.ts, page-scripts.ts, snapshot.ts, serialize.ts, socket-write.ts and daemon/protocol.ts have no value imports from src"`. Append:

```ts
  {
    name: "only src/page-scripts.ts builds an IIFE string for the page",
    violates: (file, text) => file !== "src/page-scripts.ts" && /\(\(\)\s*=>/.test(text),
  },
```

Run `bun test tests/layers.test.ts`; if any other `src/` file still matches (comments count), move or reword it — the rule is meant to be exact.

- [ ] **Step 5: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green; 309 + 3 (page-scripts) + 1 (layer rule) = 313 pass.

```bash
git add src/page-scripts.ts src/snapshot.ts src/browser.ts src/commands.ts tests/page-scripts.test.ts tests/layers.test.ts
git commit -m "refactor: every injected page script lives in page-scripts.ts

browser.ts, commands.ts and snapshot.ts each built their own IIFE
strings. One file now owns them, a test pins the JSON.stringify quoting
for every builder that takes user input, and a layer rule keeps IIFEs
out of every other file."
```

---

### Task 2: split `commands.ts` into `commands/*.ts`

**Files:**
- Create: `src/commands/context.ts`, `src/commands/navigation.ts`, `src/commands/interaction.ts`, `src/commands/snapshot.ts`, `src/commands/web-storage.ts`, `src/commands/cookies.ts`, `src/commands/storage-state.ts`, `src/commands/scripting.ts`, `src/commands/install.ts`
- Delete: `src/commands.ts`
- Modify: `src/cli.ts` (imports only)
- Modify: import lines in `tests/commands.test.ts`, `tests/cookie.test.ts`, `tests/state-storage.test.ts`, `tests/install.test.ts`, `tests/screenshot.test.ts`, `tests/e2e.test.ts`, `tests/e2e-todo.test.ts`, `tests/e2e-cookie.test.ts`, `tests/e2e-search.test.ts`, `tests/e2e-compat.test.ts`, `tests/e2e-webkit.test.ts`
- Modify: `tests/layers.test.ts` rule 4

**Interfaces (what each module exports; bodies move verbatim):**

| Module | Exports | Module-private helpers that move with them |
| --- | --- | --- |
| `context.ts` | `CommandContext`, `withClient`, `emptyState`, `loadRef` | `connector` (exported too: `closeOne` needs it) |
| `navigation.ts` | `cmdOpen`, `cmdGoto`, `cmdHistory`, `cmdClose`, `cmdList` | `assertNavigated`, `closeOne`, `closeAll` |
| `interaction.ts` | `cmdClick`, `cmdFill`, `cmdType`, `cmdPress`, `cmdHover`, `cmdSelect`, `cmdCheck`, `cmdUncheck`, `cmdResize` | — |
| `snapshot.ts` | `cmdSnapshot`, `cmdScreenshot`, `nextAvailablePath` | — |
| `web-storage.ts` | the ten `cmdLocalStorage*` / `cmdSessionStorage*` consts | `storageList`, `storageGet`, `storageSet`, `storageDelete`, `storageClear` |
| `cookies.ts` | `CookieListOptions`, `CookieSetOptions`, `CookieDeleteOptions`, `cmdCookieList`, `cmdCookieGet`, `cmdCookieSet`, `cmdCookieDelete`, `cmdCookieClear` | `cookieUrls` |
| `storage-state.ts` | `cmdStateSave`, `cmdStateLoad` | `StorageStateCookie`, `StorageStateOrigin`, `StorageState`, `normalizeSameSite`, `pageOrigin` |
| `scripting.ts` | `cmdEval`, `cmdRunCode` | `formatEvalResult` |
| `install.ts` | `InstallOptions`, `cmdInstall` | — |

Each module's imports are the subset it needs: `context.ts` imports `connectOrSpawn` from `../daemon/client.ts`, `DaemonConnection` from `../daemon/protocol.ts`, `loadState`/`resolveRef`/`SessionState` from `../state.ts`; `navigation.ts` imports `socketPath` from `../daemon/client.ts`, `readdir`/`unlink`, `sessionsRoot`/`saveState`/`loadState`, and `connector`/`withClient`/`emptyState`/`CommandContext` from `./context.ts`; `install.ts` imports `bowserCacheRoot`/`detectChromium` from `../backend.ts`; and so on. No module imports `../browser.ts`.

- [ ] **Step 1: Create the modules**

Move each function with its doc comment, in the same order as today, into the module the table names. The section comments in `commands.ts` ("Web Storage commands…", "Cookie commands — require the chrome backend…", "Storage state (state-save / state-load)…", "Evaluate commands…", "Download a headless Chromium…") become the header of their module. `context.ts` gets this header:

```ts
// What every command shares: the context the CLI builds, the daemon
// connection with its close, the empty session state, and ref lookup.
```

`cli.ts`: replace the single `import { … } from "./commands.ts"` with one import per module, listing exactly the names the switch uses. Nothing else in `cli.ts` changes.

Delete `src/commands.ts` with `git rm`.

- [ ] **Step 2: Repoint the tests**

Every `from "../src/commands.ts"` import splits into one import per owning module (names above). `type CommandContext` comes from `../src/commands/context.ts`. `tests/screenshot.test.ts` imports `nextAvailablePath` from `../src/commands/snapshot.ts`. No test body changes. Afterwards `grep -rn 'src/commands.ts' src tests` prints nothing.

- [ ] **Step 3: Layer rule 4**

```ts
  {
    name: "commands/* talk to the daemon only through client.ts and protocol.ts (never browser.ts or daemon/server.ts)",
    violates: (file, text) =>
      file.startsWith("src/commands/") &&
      valueImports(text).some((s) => s.endsWith("browser.ts") || s.endsWith("daemon/server.ts")),
  },
```

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 313 pass (a move adds no tests). Also: `grep -rn "from \"\.\./browser.ts\"" src/commands` prints nothing.

```bash
git add -A src/commands src/commands.ts src/cli.ts tests
git commit -m "refactor: split commands.ts into commands/{context,navigation,interaction,snapshot,web-storage,cookies,storage-state,scripting,install}.ts

A pure move: every function keeps its body, doc comment and export
name; only the file it lives in and the import lines change. cli.ts's
switch is untouched until the registry (PR 5) replaces it."
```

---

### Task 3: `reply()` and `syncState()` in `context.ts`

**Files:**
- Modify: `src/commands/context.ts` (add both)
- Modify: every `src/commands/*.ts` that has a `ctx.json ? JSON.stringify(…) : …` reply or a `saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() })`
- Modify: `tests/commands.test.ts` (two unit tests for the helpers, appended)

**Interfaces:**
- Produces: `reply(ctx: CommandContext, json: Record<string, unknown>, text: string): string` and `syncState(prev: SessionState, state: PageState): Promise<void>` (`PageState` from `../daemon/protocol.ts`).

- [ ] **Step 1: Failing tests**

Append to `tests/commands.test.ts`:

```ts
describe("context helpers", () => {
  test("reply picks JSON or text by ctx.json, with identical JSON.stringify output", () => {
    expect(reply({ session: "s", json: true }, { ok: true, ref: "e1" }, "clicked e1")).toBe(JSON.stringify({ ok: true, ref: "e1" }));
    expect(reply({ session: "s", json: false }, { ok: true, ref: "e1" }, "clicked e1")).toBe("clicked e1");
  });

  test("syncState keeps refs and name, replaces url and title, bumps updatedAt", async () => {
    await saveState({ name: "sync", url: "https://old/", title: "Old", refs: [{ id: "e1", role: "link", name: "x", selector: "a" }], updatedAt: 1 });
    const prev = (await loadState("sync"))!;
    await syncState(prev, { url: "https://new/", title: "New" });
    const next = (await loadState("sync"))!;
    expect(next.url).toBe("https://new/");
    expect(next.title).toBe("New");
    expect(next.refs).toEqual(prev.refs);
    expect(next.updatedAt).toBeGreaterThan(1);
  });
});
```

Add `reply`, `syncState` to the `../src/commands/context.ts` import and `loadState` to the `../src/state.ts` import if missing. The `Ref` shape used above must match `src/state.ts`'s `Ref` (check the field names; adjust the literal, not the assertion).

- [ ] **Step 2: Implement**

In `context.ts`:

```ts
/** Every command answers the same way: a JSON object under --json, a line
 *  otherwise. The object is stringified here so all commands agree on it. */
export function reply(ctx: CommandContext, json: Record<string, unknown>, text: string): string {
  return ctx.json ? JSON.stringify(json) : text;
}

/** After an action that may have navigated, persist the page the daemon
 *  reports while keeping the session's refs. */
export async function syncState(prev: SessionState, state: PageState): Promise<void> {
  await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
}
```

- [ ] **Step 3: Rewrite the call sites**

Every `return ctx.json ? JSON.stringify(X) : Y;` becomes `return reply(ctx, X, Y);`, including the multi-line ones (`cmdOpen`, `cmdGoto`, `cmdClick`, `cmdHistory`, `cmdScreenshot`, `cmdResize`, `closeOne`, `cmdStateSave`, `cmdStateLoad`, `cmdInstall` (both), the cookie commands, `cmdCookieGet`'s two-branch form becomes `reply(ctx, found ? { ok: true, cookie: found } : { ok: false }, found ? found.value : "")`). Cases where the JSON branch is not an object literal built for the reply (`cmdSnapshot` returns `toJson(snap)`; `cmdList` returns `JSON.stringify(names)`; `storageList` returns `JSON.stringify(obj)`; `cmdCookieList` returns `JSON.stringify(cookies)`; `closeAll` has an early JSON return) stay as they are — `reply` is for the `{ ok: true, … }` shape only.

`saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() })` in `cmdGoto`, `cmdClick`, `cmdHistory` becomes `await syncState(prev, state)`. `cmdOpen` builds a fresh state with `refs: []` and stays as it is.

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 315 pass; no expected string in any test changed. `grep -rn 'ctx.json ? JSON.stringify({' src/commands` prints nothing.

```bash
git add src/commands tests/commands.test.ts
git commit -m "refactor: reply() and syncState() replace the two lines every command repeated

Output is byte-identical: reply stringifies the same object the call
site built. syncState is the save-after-action that goto, click and the
history commands each spelled out."
```

---

### Task 4: layer rules check, docs, changelog, full gate, PR

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `openspec/specs/GLOSSARY.md`

- [ ] **Step 1: CLAUDE.md**

Table row `| What command does X? | …` → `| What command does X? | \`src/cli.ts\` (dispatcher), \`src/cli/schemas.ts\` (per-command flags), \`src/commands/<domain>.ts\` (implementations; \`context.ts\` has what they share) |`. Add a row: `| A script injected into the page? | \`src/page-scripts.ts\` — the only file that builds one |`.

Conventions bullet `**Per-command implementations** in \`src/commands.ts\` use \`loadRef(session, ref)\`…` → `**Per-command implementations** live in \`src/commands/<domain>.ts\` and use the \`context.ts\` helpers: \`withClient\`, \`loadRef(session, ref)\` for ref-action commands, \`emptyState(name)\` for null-state fallbacks, \`reply(ctx, json, text)\` for the answer, \`syncState(prev, state)\` after an action that may navigate.`

"Adding a command" step 2 → `2. Add \`cmdDblclick\` in the \`src/commands/<domain>.ts\` it belongs to (\`interaction.ts\` here; use \`loadRef\` if it takes a ref, \`reply\` for the answer). A new page script goes in \`src/page-scripts.ts\`.`

Gotcha `**\`JSON.stringify(selector)\` is mandatory in evaluate-shims.**` → replace `\`src/browser.ts\` and \`src/commands.ts\` build IIFE strings injected into the page` with `\`src/page-scripts.ts\` builds every IIFE string injected into the page (a layer rule keeps them out of other files)`; keep the rest of the sentence.

- [ ] **Step 2: GLOSSARY and CHANGELOG**

`openspec/specs/GLOSSARY.md` CLI row: `implementations in \`src/commands.ts\`` → `implementations in \`src/commands/<domain>.ts\``.

`CHANGELOG.md` under `## [Unreleased]` → `### Changed`, append:

```markdown
- **`src/commands.ts` is now `src/commands/{context,navigation,interaction,snapshot,web-storage,cookies,storage-state,scripting,install}.ts`**,
  and every script injected into the page lives in `src/page-scripts.ts`. `reply()` and `syncState()` in
  `context.ts` replace the two lines every command repeated. No output, `--json` or wire change.
```

- [ ] **Step 3: Full gate, push, PR**

```bash
cd <worktree> && bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
bun build src/cli.ts --compile --outfile dist/bowser && BOWSER_BACKEND=webkit ./dist/bowser open https://example.com && ./dist/bowser snapshot && ./dist/bowser close
pgrep -fl "daemon/main|--daemon"
```

Expected: all green (WebKit full run 0 fail, 1 todo; Chromium trio 12 pass); the binary commands return promptly; pgrep shows nothing of ours. Wrap e2e and binary commands in `perl -e 'alarm 900; exec @ARGV or die' --`.

```bash
git add CLAUDE.md CHANGELOG.md openspec/specs/GLOSSARY.md
git commit -m "docs: commands/<domain>.ts, context.ts helpers and page-scripts.ts"
git push -u origin refactor/4-commands-split
gh pr create --base main --title "Refactor PR 4: commands split, context helpers, page-scripts" --body-file - <<'EOF'
Fourth PR of the maintainability series (spec: docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md, Section 1).

- `src/commands.ts` → `src/commands/{context,navigation,interaction,snapshot,web-storage,cookies,storage-state,scripting,install}.ts`; pure move, no barrel.
- `src/page-scripts.ts` owns every script injected into the page; a test pins the `JSON.stringify` quoting of every builder that takes user input, and a layer rule keeps IIFE strings out of every other file.
- `reply()` and `syncState()` in `context.ts` replace the reply ternary and the save-after-action that every command repeated. Output is byte-identical.
- Layer rules: `commands/*` never import `browser.ts` or `daemon/server.ts`; `page-scripts.ts` imports nothing.

Not in this PR: the command registry and generated HELP/MCP (PR 5); wording changes toward `playwright-cli` (left alone, per the spec's default).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj
EOF
```

---

## Self-review against the spec

- **Section 1 layout:** every `commands/*` file the spec lists exists with the listed contents (`context.ts` has `CommandContext`, `withClient()`, `reply()`, `syncState()`, `loadRef()`, `emptyState()`); `page-scripts.ts` holds `SNAPSHOT_SCRIPT` and the hover/select/setChecked/clear-for-fill/storage scripts; `snapshot.ts` keeps `toYaml`, `toJson`, `SnapshotResult`.
- **Layer rules from Section 1:** `commands/*` never imports `browser.ts` or `daemon/server.ts` (Task 2 rule); `commands/install.ts` imports `backend.ts` (already true after PR 3; covered by the same rule); `page-scripts.ts` imports nothing (Task 1). The IIFE rule is this plan's addition that makes the "every snippet" claim checkable.
- **Contract:** no output changes chosen; the CHANGELOG entry says so. `tests/compat.test.ts`, `tests/snapshot.test.ts` untouched.
- **Section 3 readiness:** each module is where PR 5 will add its `Command[]`; flag unpacking stays in `cli.ts` until then.
- **Type consistency:** `reply`, `syncState`, `PageState`, `StorageArea`, builder names spelled identically across tasks. Test counts: 309 → 313 (T1) → 313 (T2) → 315 (T3).
- **Placeholder scan:** Task 2 moves code by name and table rather than reproducing 800 lines; the reviewer verifies bodies against `git show <base>:src/commands.ts`.
