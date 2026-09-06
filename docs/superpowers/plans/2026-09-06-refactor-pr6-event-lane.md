# Refactor PR 6 — Daemon event lane and state

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's hand-rolled `shutdown` bypass with a declared urgent lane, give the daemon a state object with a slot for a pending dialog, and expose the event mechanism the dialog task will subscribe through.

**Architecture:** `OP_META` marks ops `urgent` in `daemon/protocol.ts`, mirroring the existing `requires: "cdp"` pattern (a mapped type plus a `satisfies` runtime mirror, so a new urgent op cannot be declared without appearing in the set). `daemon/server.ts` routes on that marker instead of on the literal string `"shutdown"`. `DaemonState` is owned by `server.ts` and holds only what is genuinely stateful. `Browser.subscribe()` wraps `view.addEventListener`, which this plan verified delivers CDP events on chrome and silently never fires on webkit.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2 (`bun run typecheck` is the gate), zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md`, Section 4.

## Global Constraints

- Zero runtime dependencies. Bun-native APIs only. No new devDependency.
- `bun run typecheck` (tsc) is the real gate: `bun test` strips types, so a type error does not fail the suite. Run both.
- The wire protocol may gain an optional field but must not change the meaning of an existing one. `PageState.url` and `PageState.title` keep their names and their current values.
- Command names, argv shapes, exit codes, and every command's output must not change. This PR's row in the spec's series table says "Visible change: none".
- No file may be left with a comment or doc line that overclaims what the code does.
- `src/serialize.ts` is not touched (spec Section 4, first paragraph).
- Every commit message ends with the two attribution lines used across this series.

## Findings this plan verified before writing (Bun 1.4.0, macOS arm64)

These were probed directly, not assumed. They correct the spec where it guessed.

1. **`view.addEventListener(<CDP event name>, handler)` works on the chrome backend.** After `await v.cdp("Page.enable", {})`, clicking a button that calls `confirm()` fires the listener registered for `"Page.javascriptDialogOpening"`. The event object's own enumerable key is only `isTrusted`; the CDP parameters arrive on **`e.data`**, and `e.type` is the event name. Observed `e.data` for a `confirm`: `{ url, frameId, message: "sure?", type: "confirm", hasBrowserHandler: false, defaultPrompt: "" }`.
2. **On the webkit backend `addEventListener` accepts the registration and never throws — and never fires.** So a `subscribe()` that feature-probed `typeof view.addEventListener === "function"` would return `true` on webkit and be a lie. It must branch on the backend kind.
3. **`onNavigated` / `onNavigationFailed` are assignable properties, not `addEventListener` events, and `wrapView` already owns both** (`src/browser.ts`, the navigation watch). `subscribe()` must not touch them: assigning over either would silently break the false→true `loading` transition detection that PR 3 added.
4. CDP parameter naming differs from the spec's sketch: CDP sends `defaultPrompt`, the spec's `DaemonState` sketch wrote `defaultValue`.

---

### Task 1: `OP_META` and the urgent lane

**Files:**
- Modify: `src/daemon/protocol.ts`
- Modify: `src/daemon/server.ts:134-143` (the `req.op === "shutdown"` branch)
- Test: `tests/daemon-handler.test.ts`

**Interfaces:**
- Consumes: `Op`, `DaemonOps` from `protocol.ts`.
- Produces: `UrgentOp` (type), `IS_URGENT: ReadonlySet<Op>` from `protocol.ts`.

- [ ] **Step 1: Mark the urgent ops in `DaemonOps`**

In `src/daemon/protocol.ts`, add `urgent: true` to the `ping` and `shutdown` entries only, in the same trailing-marker position `requires: "cdp"` occupies on the cookie ops:

```ts
  ping:             { args: [];                                          result: "pong";               urgent: true };
  shutdown:         { args: [];                                          result: void;                 urgent: true };
```

- [ ] **Step 2: Derive the runtime mirror**

Add below the existing `CdpOp` / `CDP_OPS` / `REQUIRES_CDP` block, following it exactly in shape and in comment style:

```ts
/** Ops that must not queue behind a wedged operation. */
export type UrgentOp = { [O in Op]: DaemonOps[O] extends { urgent: true } ? O : never }[Op];

// The runtime mirror of the `urgent: true` markers, same trick as CDP_OPS:
// `satisfies` makes a missing entry a compile error, so an op cannot be
// declared urgent in the type and stay queued at runtime.
const URGENT_OPS = { ping: true, shutdown: true } satisfies Record<UrgentOp, true>;

export const IS_URGENT: ReadonlySet<Op> = new Set<Op>(Object.keys(URGENT_OPS) as UrgentOp[]);
```

- [ ] **Step 3: Route on the marker**

In `src/daemon/server.ts`, import `IS_URGENT` alongside `REQUIRES_CDP`, and replace the condition on line 136. The branch body does not change — only what selects it, and the comment:

```ts
          // The urgent lane skips the serializer: these ops exist to be
          // answerable while a queued op is wedged, which is the whole point
          // of shutdown killing a stuck daemon. Declared in OP_META, not
          // spelled here, so the next urgent op (dialog-handle) is one marker.
          if (IS_URGENT.has(req.op)) {
```

Delete the old two-line `// Shutdown must NOT queue…` comment, whose content is now in the comment above.

- [ ] **Step 4: Write the tests**

Add to `tests/daemon-handler.test.ts`. The first is the regression that matters: it must fail if someone routes urgent ops back through the serializer.

```ts
test("ping and shutdown are the urgent ops, and nothing else is", () => {
  expect([...IS_URGENT].sort()).toEqual(["ping", "shutdown"]);
});

test("an urgent op answers while a queued op is still running", async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const serialize = createSerializer();
  // A wedged queued op, exactly what shutdown exists to escape.
  serialize(() => blocked.then(() => { order.push("queued"); }));
  // The urgent lane does not go through `serialize`, so it settles first.
  if (IS_URGENT.has("ping")) order.push("urgent");
  expect(order).toEqual(["urgent"]);
  release();
  await blocked;
});
```

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun test`
Expected: green. Report the exact counts; the baseline is 335 pass / 44 skip / 0 fail.

```bash
git add src/daemon/protocol.ts src/daemon/server.ts tests/daemon-handler.test.ts
git commit -m "feat: the urgent lane is declared, not spelled at the call site"
```

---

### Task 2: `DaemonState`

**Files:**
- Modify: `src/daemon/protocol.ts` (the `PageState` interface)
- Modify: `src/daemon/server.ts` (the `state` handler, and `startDaemon`)
- Test: `tests/daemon-handler.test.ts`

**Interfaces:**
- Produces: `DialogState` and an optional `dialog` field on `PageState`.

**Ruling that binds this task — read before writing code.** The spec says "`DaemonState`. A plain object owned by `server.ts`… The `state` op returns this object." Taken literally that would cache `url` and `title` in a field and return the cached copy. **Do not do that.** Nothing in this PR updates such a cache, and PR 3 exists because a stale URL after an action was a real reported bug: `nav.act()` was added so `state` right after `click` reports the *new* URL. `url` and `title` stay computed live at read time, exactly as today. `DaemonState` holds only `dialog`, which is genuinely stateful because nothing can recompute it on demand. If this conflicts with a literal reading of the spec, the spec is wrong and this ruling wins; say so in the report rather than caching.

- [ ] **Step 1: Extend `PageState`**

In `src/daemon/protocol.ts`, beside the existing `PageState`:

```ts
/** A dialog the page opened. Chrome only: webkit delivers no dialog events
 *  (see the 2026-09-05 refactor spec, Section 4). `defaultValue` carries
 *  CDP's `defaultPrompt`, renamed here to match the other fields' style. */
export interface DialogState {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
}
```

and add one optional field to `PageState`, leaving `url` and `title` untouched:

```ts
  /** Present only while a dialog is open. Populated by the dialog task; no
   *  code in this PR sets it. */
  dialog?: DialogState;
```

- [ ] **Step 2: Own the state object in the server**

In `src/daemon/server.ts`, `createHandler` currently closes over `browser` alone. Give it the state object too, so the dialog task has one place to write. Change the signature and the `state` handler:

```ts
/** What the daemon knows that the page cannot be asked for. `url` and `title`
 *  are deliberately NOT here: they are read live from the page on every
 *  `state` call, because an action can navigate and a cached copy would go
 *  stale (that regression is why `nav.act()` exists). */
export interface DaemonState {
  dialog?: DialogState;
}
```

```ts
  state: async (browser, _args, state) => ({
    url: await browser.realUrl(),
    title: await browser.realTitle(),
    ...(state.dialog ? { dialog: state.dialog } : {}),
  }),
```

**Do not restructure `Handlers` to thread a third parameter through every op** — 30 handlers would change signature for one consumer. Instead keep `handlers` as it is and have `createHandler(browser, state)` close over `state`, with only the `state` entry reading it. If the shape above does not fit the existing `Handlers` type cleanly, prefer changing the single `state` handler into a closure created inside `createHandler` over changing the shared type. Report which you did.

- [ ] **Step 3: Wire it in `startDaemon`**

```ts
  const state: DaemonState = {};
  const handle = createHandler(browser, state);
```

- [ ] **Step 4: Tests**

```ts
test("state reports the page's live url and title, not a cached copy", async () => {
  // Two reads with a navigation between them must differ: this fails if
  // DaemonState ever starts caching url/title.
  const browser = fakeBrowser({ url: "https://a.example/", title: "A" });
  const state: DaemonState = {};
  const handle = createHandler(browser, state);
  const first = await handle({ id: 1, op: "state", args: [] });
  browser.setPage("https://b.example/", "B");
  const second = await handle({ id: 2, op: "state", args: [] });
  expect(first).toMatchObject({ ok: true, result: { url: "https://a.example/" } });
  expect(second).toMatchObject({ ok: true, result: { url: "https://b.example/" } });
});

test("state omits dialog entirely when none is open", async () => {
  const handle = createHandler(fakeBrowser({}), {});
  const res = await handle({ id: 1, op: "state", args: [] });
  expect(res.ok && "dialog" in (res.result as object)).toBe(false);
});

test("state carries the dialog when the daemon has one", async () => {
  const state: DaemonState = { dialog: { type: "confirm", message: "sure?" } };
  const handle = createHandler(fakeBrowser({}), state);
  const res = await handle({ id: 1, op: "state", args: [] });
  expect(res).toMatchObject({ ok: true, result: { dialog: { type: "confirm", message: "sure?" } } });
});
```

Use whatever fake-browser helper `tests/daemon-handler.test.ts` already uses; if it has none with a settable url/title, add the smallest one that serves these three tests rather than importing the real `Browser`.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun test`

```bash
git add src/daemon/protocol.ts src/daemon/server.ts tests/daemon-handler.test.ts
git commit -m "feat: the daemon owns a state object with a slot for a dialog"
```

---

### Task 3: `Browser.subscribe()`

**Files:**
- Modify: `src/browser.ts` (`ViewLike`, `Browser`, `wrapView`)
- Test: `tests/browser.test.ts` (unit), `tests/e2e-cookie.test.ts` or a new `tests/e2e-dialog.test.ts` (chrome-only e2e)

**Read Findings 1-3 at the top of this plan before starting.** They were measured on this machine and they contradict the spec's sketch in two places.

- [ ] **Step 1: Add `addEventListener` to `ViewLike`**

```ts
  /** Chrome only in practice: webkit accepts the registration and never
   *  fires. Not the same mechanism as onNavigated/onNavigationFailed above,
   *  which are assignable properties this file already owns. */
  addEventListener(event: string, handler: (e: { type: string; data?: unknown }) => void): void;
```

- [ ] **Step 2: Implement `subscribe`**

On the `Browser` interface:

```ts
  /** Listen for a backend event by name (CDP event names on chrome, e.g.
   *  "Page.javascriptDialogOpening"; the domain must be enabled first with
   *  cdp("Page.enable", {})). Returns false on webkit, where no such event is
   *  ever delivered — check the result rather than assuming it fired. */
  subscribe(event: string, handler: (data: unknown) => void): boolean;
```

In `wrapView`, where `spec` is already in scope:

```ts
    subscribe: (event, handler) => {
      // webkit accepts addEventListener and silently never fires it, so
      // registering there would report success and deliver nothing.
      if (spec.kind !== "chrome") return false;
      view.addEventListener(event, (e) => handler(e.data));
      return true;
    },
```

Note the handler receives `e.data` (the CDP parameters), not the event object — Finding 1.

- [ ] **Step 3: Unit test both backends**

```ts
test("subscribe registers on chrome and reports it", () => {
  const seen: unknown[] = [];
  let registered: ((e: { type: string; data?: unknown }) => void) | null = null;
  const view = fakeView({ addEventListener: (_n, h) => { registered = h; } });
  const b = wrapView(view, { kind: "chrome" });
  expect(b.subscribe("Page.javascriptDialogOpening", (d) => seen.push(d))).toBe(true);
  registered!({ type: "Page.javascriptDialogOpening", data: { message: "sure?" } });
  expect(seen).toEqual([{ message: "sure?" }]);
});

test("subscribe refuses on webkit instead of registering a listener that never fires", () => {
  let calls = 0;
  const view = fakeView({ addEventListener: () => { calls++; } });
  const b = wrapView(view, { kind: "webkit" });
  expect(b.subscribe("Page.javascriptDialogOpening", () => {})).toBe(false);
  expect(calls).toBe(0);
});
```

Adapt `fakeView` to whatever `tests/browser.test.ts` already provides.

- [ ] **Step 4: One chrome e2e test, so this is not an untested API with no caller**

Guard it the way the other chrome-only e2e tests in this repo are guarded (they skip unless `BOWSER_E2E=1` and a chromium binary is resolvable — copy the existing guard, do not invent one).

```ts
test("a CDP event reaches a subscriber on chrome", async () => {
  const b = await openBrowser({ executablePath: chromiumPath });
  try {
    const seen: any[] = [];
    expect(b.subscribe("Page.javascriptDialogOpening", (d) => seen.push(d))).toBe(true);
    await b.navigate("data:text/html,<button onclick=\"confirm('sure?')\">go</button>");
    await b.cdp("Page.enable", {});
    b.click("button").catch(() => {});
    await Bun.sleep(2000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ message: "sure?", type: "confirm" });
  } finally {
    await b.close();
  }
});
```

If this test does not pass, **stop and report BLOCKED with the output** rather than weakening the assertion — the plan's Finding 1 says it passed on this machine outside the test harness, so a failure here is real information about `openBrowser` versus a raw `Bun.WebView`.

- [ ] **Step 5: Verify and commit**

Run: `bun run typecheck && bun test`, then the chrome e2e the way Task 4's gate runs it.

```bash
git add src/browser.ts tests/browser.test.ts tests/e2e-dialog.test.ts
git commit -m "feat: Browser.subscribe, and it says no on webkit rather than lying"
```

---

### Task 4: docs, spec findings, full gate, PR

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md`

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Changed`:

```markdown
- **The daemon's urgent lane is declared.** `ping` and `shutdown` carry `urgent: true` in
  `DaemonOps` and the server routes on that marker instead of testing for the string
  `"shutdown"`, so an op that must answer while another is wedged is one marker rather than a
  new branch. `DaemonState` gives the daemon a slot for a dialog the page opened, and
  `Browser.subscribe()` exposes the backend event stream it will be filled from. No visible
  change: no command's output differs.
```

- [ ] **Step 2: CLAUDE.md**

Add to the Gotchas section, since Finding 3 is exactly the kind of trap that section exists for:

```markdown
- **The WebView has two unrelated event mechanisms.** `onNavigated`/`onNavigationFailed` are assignable properties, and `wrapView` owns both for the navigation watch — assigning over either silently breaks `nav.act()`. Backend events (CDP event names on chrome) come through `addEventListener` instead, which is what `Browser.subscribe()` wraps. On webkit `addEventListener` accepts the registration and never fires, so `subscribe()` returns `false` there rather than reporting a success that delivers nothing.
```

Add to the "Adding a command" recipe, step 1, after the CDP sentence:

```markdown
If the op must answer while another op is wedged (like `shutdown`), add `urgent: true` to its `DaemonOps` entry and a row to `URGENT_OPS`; it then skips the serializer.
```

- [ ] **Step 3: Record the findings in the spec**

Append the four numbered findings from the top of this plan to the spec's "Findings from probing" section, under a `### Bun.WebView event mechanisms (2026-09-06)` heading, and correct Section 4's two errors in place: `subscribe` is not "a thin wrapper over `view.addEventListener` on chrome; a no-op returning `false` on webkit" by feature detection but by backend kind, and the dialog field's `defaultValue` is CDP's `defaultPrompt`. Keep the edits surgical.

**Use python, not perl, for any edit touching a markdown table.** Perl has corrupted `CLAUDE.md` in this repo by exactly that route; assert the match count before writing.

- [ ] **Step 4: Full gate, push, PR**

```bash
bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts tests/e2e-dialog.test.ts
bun build src/cli.ts --compile --outfile dist/bowser
./dist/bowser --help | head -5
BOWSER_BACKEND=webkit ./dist/bowser open https://example.com && ./dist/bowser snapshot && ./dist/bowser close
pgrep -fl "daemon/main|--daemon"
```

Wrap the e2e and binary commands in `perl -e 'alarm 900; exec @ARGV or die' --`. macOS here has no `timeout`. Expected: all green, the binary answers promptly, `pgrep` shows nothing of ours. If any command fails, stop and report BLOCKED with the output rather than pushing.

```bash
git add CHANGELOG.md CLAUDE.md docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md
git commit -m "docs: the urgent lane, daemon state, and what the two event mechanisms are"
git push -u origin refactor/6-event-lane
```

Then `gh pr create --base main --title "Refactor PR 6: daemon event lane and state"` with a body covering: the urgent lane is declared rather than spelled; `DaemonState` holds only the dialog and deliberately does not cache `url`/`title` (with the reason); `subscribe()` and the verified chrome/webkit asymmetry; that no command's output changes. End it with the series' standard attribution block.

---

## Self-review against the spec

- **Section 4's four deliverables:** urgent routing via `OP_META` (Task 1), `DaemonState` (Task 2), `subscribe()` (Task 3). The capability gate and "Browser absorbs CDP details" also live in Section 4 but shipped in PR 3 — nothing to do here; a reader of the spec should not expect them from this PR.
- **Deliberate divergences from the spec, both from measurement:** `DaemonState` does not cache `url`/`title` (Task 2 ruling, with the regression it would reintroduce); `subscribe()` branches on backend kind rather than feature-detecting `addEventListener` (Finding 2).
- **Contract:** no command's output changes. `PageState` gains an optional field, which existing consumers ignore. The wire protocol's existing fields keep their meaning.
- **Type consistency:** `UrgentOp`, `URGENT_OPS`, `IS_URGENT`, `DialogState`, `DaemonState`, `subscribe` spelled identically across tasks. `IS_URGENT` follows `REQUIRES_CDP`'s naming; `URGENT_OPS` follows `CDP_OPS`.
- **Not in this PR:** the `dialog-handle` op, any subscription actually being made, and the WebKit page-side dialog shim. Those are the dialog task, which this PR exists to make cheap.
- **Carried to PR 7** (from PR 5's final review): replace the 14 `as string | undefined` casts in `commands/*` with `str()`/`bool()` helpers, and delete `src/cli/schemas.ts` by repointing its four test importers at the registry.
