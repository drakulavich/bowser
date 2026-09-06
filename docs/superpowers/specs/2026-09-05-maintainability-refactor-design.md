# Maintainability refactor — design

**Date:** 2026-09-05
**Status:** approved design, awaiting implementation plan
**Scope:** `src/` structure, daemon protocol typing, command registry, daemon event lane
**Drives:** the unchecked README roadmap items, in the order they are planned — `dialog-accept`/`dismiss` first, then `route`/`unroute`, tabs, tracing/PDF.

## Goal

Make bowser cheaper to extend and safer to change without altering what it
does for an agent written against `playwright-cli`. Three concrete pains
today:

1. **A command lives in six places.** `src/cli/schemas.ts`, the switch in
   `src/cli.ts`, the hand-written HELP in the same file, `DESCRIPTIONS` in
   `src/mcp.ts`, the README table, and `skills/bowser/SKILL.md`. CLAUDE.md
   documents this as a six-step procedure.
2. **The daemon protocol is stringly typed.** Every `c.request("state")` is
   cast at the call site, `handle()` reads `args[0] as string`, and the test
   `fakeClient` re-implements the op switch by hand. Nothing stops the three
   from drifting.
3. **`src/commands.ts` (821 lines) mixes six domains**, and the daemon knows
   CDP method names that belong behind the `Browser` interface.

The backlog adds a fourth: the daemon must become **event-driven and
stateful** (a pending dialog, later route rules) and must be able to answer
some requests **outside its serialized queue** (a dialog blocks the page, so
the op that opened it hangs until the dialog is handled). Today `shutdown` is
the only such case and it is a special-cased branch.

## The contract

The reference behavior is **`playwright-cli` on the WebKit backend**. WebKit
is the macOS default and the backend the owner uses; `playwright-cli` is what
agent skills are written against. Bowser's own current output is *not* the
contract: where it deviates from `playwright-cli`, the refactor may move it
closer, and where it is merely bowser-specific (the wording of
`clicked e1 (link "Home")`, `--json` field names) it may change when that
simplifies the code. Every such change is listed in CHANGELOG.

What is pinned because it *is* the `playwright-cli` contract:

- command names and argv shapes (`tests/compat.test.ts`);
- bare `eN` refs, and the snapshot YAML **frozen at its current shape**
  (`tests/snapshot.test.ts`). That shape is *not* what `playwright-cli`
  0.1.13 prints today; see "Findings" below. Parity is scheduled after this
  refactor, not inside it;
- exit codes 0 / 1 / 2 and the user-error message prefixes;
- a named session surviving between commands.

What is pinned for other reasons: `state.json` (a running daemon must keep
working across an upgrade), wire op names (same reason), zero runtime
dependencies, Bun-native APIs.

Known to change in this series: `bowser --help` text (generated), MCP tool
descriptions (same `summary` string), and possibly some bowser-specific
result wording (PR 4, only toward `playwright-cli`).

## Non-goals

- No new user-facing commands. `dialog-*` is the next task *after* this
  refactor, not part of it.
- No multi-page daemon. Tabs get a reserved `page` field in the request
  envelope and nothing else.
- No change to `openspec/` or the release workflow.
- No new abstractions for their own sake: every module below replaces
  something that exists, or is required by the first backlog item.

## Section 1 — Target module layout

```
src/
  cli.ts                 entry only: --daemon, mcp, run(); HELP is generated
  cli/parser.ts          unchanged
  cli/registry.ts        the command registry (Section 3); schemas derived from it
  commands/
    context.ts           CommandContext, withClient(), reply(), syncState(), loadRef(), emptyState()
    navigation.ts        open, goto, go-back, go-forward, reload, close, list
    interaction.ts       click, fill, type, press, hover, select, check, uncheck, resize
    snapshot.ts          snapshot, screenshot (+ nextAvailablePath)
    web-storage.ts       localstorage-*, sessionstorage-*
    cookies.ts           cookie-*
    storage-state.ts     state-save, state-load
    scripting.ts         eval, run-code
    install.ts           install
  page-scripts.ts        every JS snippet injected into the page (snapshot, storage, hover, select, setChecked, clear-for-fill)
  daemon/
    protocol.ts          DaemonOps map, DaemonRequest/DaemonResponse, Op
    server.ts            startDaemon: socket, serializer, dispatch by DaemonOps, DaemonState
    client.ts            DaemonClient, connectOrSpawn, spawnDaemon
    main.ts              spawn entry (today's daemon-main.ts)
  browser.ts             Browser interface + openBrowser; gains cookie methods and subscribe()
  backend.ts             resolveBackend, assertValidBackendEnv, toBunBackend, detectChromium, hasExplicitChromium, bowserCacheRoot
  snapshot.ts            toYaml, toJson, SnapshotResult (SNAPSHOT_SCRIPT moves to page-scripts.ts)
  state.ts, serialize.ts, socket-write.ts, cdp/types.ts   unchanged
```

Layer rules, enforced by a test that reads import statements in `src/`:

| Rule | Why |
| --- | --- |
| `commands/*` never imports `browser.ts` or `daemon/server.ts` | commands talk to the daemon only through `DaemonClient` |
| `daemon/server.ts` is the only importer of `Browser` | the daemon is the sole owner of the WebView |
| `browser.ts` is the only file mentioning `Bun.WebView` | one place for `@ts-expect-error` and the shape casts |
| `commands/install.ts` imports `backend.ts`, not `browser.ts` | keeps the first rule true |
| `page-scripts.ts` imports nothing from `src/` | scripts are self-contained strings |

`cli.ts` keeps the `import.meta.main` block as-is (the `--daemon` and `mcp`
intercepts are load-bearing; see CLAUDE.md gotchas). Only its `run()` body
changes.

## Section 2 — Typed daemon protocol

`src/daemon/protocol.ts` holds one map. Sketch, not final names:

```ts
export interface DaemonOps {
  ping:             { args: [];                        result: "pong";                       urgent: true };
  shutdown:         { args: [];                        result: void;                         urgent: true };
  state:            { args: [];                        result: DaemonState };
  navigate:         { args: [url: string];             result: void };
  evaluate:         { args: [expr: string];            result: unknown };
  click:            { args: [selector: string];        result: void };
  type:             { args: [text: string];            result: void };
  press:            { args: [key: string];             result: void };
  hover:            { args: [selector: string];        result: void };
  select:           { args: [selector: string, value: string]; result: void };
  check:            { args: [selector: string];        result: void };
  uncheck:          { args: [selector: string];        result: void };
  screenshot:       { args: [path?: string];           result: { path: string } | string };
  resize:           { args: [width: number, height: number]; result: void };
  back:             { args: [];                        result: void };
  forward:          { args: [];                        result: void };
  reload:           { args: [];                        result: void };
  "cookie-get-all": { args: [urls?: string[]];         result: Cookie[];             requires: "cdp" };
  "cookie-set":     { args: [param: CookieParam];      result: { success: boolean }; requires: "cdp" };
  "cookie-delete":  { args: [name: string, opts?: DeleteCookieOptions]; result: void; requires: "cdp" };
  "cookie-clear":   { args: [];                        result: void;                 requires: "cdp" };
}
export type Op = keyof DaemonOps;

export interface DaemonRequest<O extends Op = Op> {
  id: number;
  op: O;
  args: DaemonOps[O]["args"];
  /** Reserved for tab support. Ignored by the server today; never set by the client. */
  page?: string;
}
```

`urgent` and `requires` are type-level markers mirrored by a small runtime
table (`OP_META: Record<Op, { urgent?: true; requires?: "cdp" }>`) so the
server can route on them. A test asserts the table has exactly the keys of
`DaemonOps`.

Derived from the map:

- `DaemonClient.request<O extends Op>(op: O, ...args: DaemonOps[O]["args"]): Promise<DaemonOps[O]["result"]>`.
  Call sites lose every `as { url: string; title: string }`.
- Server dispatch: `const handlers: { [O in Op]: (b: Browser, ...a: DaemonOps[O]["args"]) => Promise<DaemonOps[O]["result"]> }`.
  A missing or mistyped handler is a compile error; the `default: unknown op`
  branch stays only for malformed wire input.
- Test double: `fakeClient(handlers: Partial<Handlers>)` in
  `tests/commands.test.ts` is typed from the same map and loses its hand-written
  switch. Recorded `calls` keep their `[op, args]` shape so existing assertions
  do not change.

Wire format is unchanged: newline-delimited JSON, same op names, same
`{ id, ok, result | error }` responses. A client from this refactor can talk to
a daemon started before it and vice versa.

## Section 3 — Command registry

`src/cli/registry.ts`:

```ts
export interface Positional { name: string; required: boolean }
export interface Command {
  name: string;
  /** One line. Feeds both `--help` and the MCP tool description. */
  summary: string;
  positional: Positional[];
  flags: FlagSpec[];
  /** Omit from `bowser mcp`. Replaces MCP_EXCLUDED. */
  mcp?: false;
  run(ctx: CommandContext, args: CommandArgs): Promise<string>;
}
export interface CommandArgs { positional: string[]; flags: Record<string, string | boolean> }
export const COMMANDS: readonly Command[];
export const SCHEMAS: Schemas;   // derived: { global, commands: COMMANDS.map(pick name/positional/flags) }
```

Each `commands/*.ts` module exports its `Command[]`; the registry concatenates
them. Flag unpacking (`args.flags.domain as string | undefined`, the
`expires` `Number()` conversion, the `same-site` literal cast) moves into the
command's own `run`, next to the schema that declares the flag.

Consumers:

- **Dispatch.** `run(argv)` in `cli.ts` becomes: parse, find the command by
  name, call `run`. The 60-line switch is deleted. `mcp` stays a registry entry
  with a `run` that throws the same usage error as today, so the intercept
  comment in `cli.ts` remains true.
- **HELP.** Generated: one line per command, `name`, positionals in `<>` or
  `[]`, flags as `[--flag]` or `[--flag=<v>]`, then `summary` in an aligned
  column. Global flags and the header are a fixed template. Long flag lists
  wrap onto a continuation line the way `cookie-set` does today.
- **MCP tools.** `buildTools()` reads `COMMANDS` and `summary`; `DESCRIPTIONS`
  and `MCP_EXCLUDED` are deleted. `toArgv` and the `tests/mcp.test.ts`
  round-trip tests stay; the "every command has a description" test becomes
  "every command has a non-empty summary".
- **Docs drift test.** Every `COMMANDS[].name` appears in the README command
  table and in `skills/bowser/SKILL.md`. README and SKILL stay hand-written.

`tests/compat.test.ts` and `tests/parse-args.test.ts` keep importing `SCHEMAS`
and do not change.

Net effect on "add a command": one `Command` object in the right
`commands/*.ts`, a unit test, a README row, a SKILL.md line. The compiler and
the drift test catch the rest.

## Section 4 — Daemon event lane and state

Today the daemon has one path (queue, then reply) plus a hand-rolled bypass
for `shutdown`. This section generalizes it without touching
`src/serialize.ts`.

**Two lanes in `daemon/server.ts`.** On each parsed request:
`IS_URGENT.has(req.op) ? handle(req) : serialize(() => handle(req))`, where
`IS_URGENT` is a runtime `Set` derived from `urgent: true` markers on the
op's own entry in `DaemonOps` (mirroring the existing `requires: "cdp"`
pattern), not a separate `OP_META` table. `ping` and `shutdown` are urgent
now. `dialog-handle` (next task) and `page-list` (tabs, later) will be. The
`withTimeout` wrapping stays on the queued lane only.

**Capability gate.** Before calling a handler with `requires: "cdp"`, the
server checks `browser.cdpAvailable()` and answers with today's exact error
text ("CDP is only available on the chrome backend …"). The per-method check
inside `Browser.cdp()` is kept as a backstop but no handler relies on it.

**`DaemonState`.** A plain object owned by `server.ts`:

```ts
interface DaemonState {
  url: string;
  title: string;
  /** Set by Page.javascriptDialogOpening; cleared by dialog-handle. Chrome
   *  only. `defaultValue` renames CDP's own `defaultPrompt` field to match
   *  the other fields' style. */
  dialog?: { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; defaultValue?: string };
}
```

The `state` op returns this object. Today's `{ url, title }` consumers keep
working because those fields keep their names; `dialog` is absent until the
next task populates it.

**`Browser.subscribe(event, handler)`.** Wraps `view.addEventListener`,
branching on backend kind rather than feature-probing `addEventListener`
itself — webkit accepts the registration and never fires it, so a feature
probe would report `true` there and lie. `subscribe()` returns `false` on
webkit so callers can tell the difference. No subscriptions are made in this
refactor; the method exists so the dialog task adds one line, not a
`Browser` change.

**WebKit caveat for the dialog task.** `Bun.WebView` documents no dialog
events on the webkit backend, so `subscribe` alone will not deliver
`playwright-cli`-style "dialog is open, handle it" behavior there. The likely
WebKit path is a page-side shim installed after each navigation (override
`window.alert/confirm/prompt` to record the call and return a preset answer),
which means `DaemonState.dialog` must be able to hold "last dialog seen and
how it was answered" as well as "dialog pending". The field shape above allows
both; the policy is decided in the dialog task, not here.

**`Browser` absorbs CDP details.** `getCookies(urls?)`, `setCookie(param)`,
`deleteCookies(name, opts)`, `clearCookies()` move from `handle()` into
`browser.ts`, and `back`/`forward`/`reload` switch to the native
`view.goBack()`/`goForward()`/`reload()` (documented in Bun ≥ 1.3.12). The raw
`cdp()` stays public for the next tasks. E2E tests are the check that native
history behaves like the `history.back()` emulation it replaces; if they
differ on either backend, keep the emulation and record why in a comment.

How `dialog-accept` lands afterwards, for the record: the daemon subscribes to
`Page.javascriptDialogOpening` and stores `state.dialog`; the `click` that
opened it sits in the queue until `dialog-handle` arrives on the urgent lane,
calls `Page.handleJavaScriptDialog`, clears `state.dialog`, and the queued op
resumes. One `DaemonOps` entry, one `Command`, one handler.

## Section 5 — Verification: end-to-end on WebKit is the gate

Unit tests with a fake daemon prove the layers fit together. They do not prove
the tool works. The gate for this series is a real headless WebKit driven by
the real CLI, and the reference is `playwright-cli`.

**Where the suite stands today.** WebKit e2e covers `open → snapshot → click`,
`screenshot`, the socket backpressure case, and the todo flow. It does not
cover `fill`, `type`, `press`, `hover`, `select`, `check`/`uncheck`, `resize`,
`go-back`/`go-forward`/`reload`, any `localstorage-*`/`sessionstorage-*`,
`eval`/`run-code`, `list`, or `close --all` on WebKit. CI runs e2e only on
Chromium under Ubuntu; the macOS job runs unit tests only. That gap is closed
first, before any code moves.

- **PR 1 — WebKit e2e coverage and the type gate.** Plan:
  `docs/superpowers/plans/2026-09-05-refactor-pr1-webkit-e2e.md`.
  - **Typecheck gate.** `bun test` strips types and checks nothing, so a typed
    protocol without `tsc` guarantees nothing. `typescript` becomes a
    devDependency, `bun run typecheck` a script, and a CI step. Running `tsc`
    today reports three real errors (a stale `@ts-expect-error` on
    `Bun.WebView`, an untyped `backend` option, `end()` called on a
    `Promise<Socket>`); they are fixed here.
  - **WebKit title bug.** `open` on WebKit prints an empty title because
    `view.title` is still empty when `navigate()` resolves, while
    `document.title` inside the page is populated. Fixed the way `realUrl()`
    fixes the URL: read it from the page when the native getter is empty.
    The only code change in this PR besides the type fixes.
  - `tests/e2e.test.ts` and `tests/e2e-todo.test.ts` stop demanding a
    Chromium binary when the backend resolves to WebKit, so they run on both.
  - `tests/e2e-webkit.test.ts`: one agent-loop scenario against a local
    `Bun.serve` fixture that exercises every WebKit-capable command listed
    above, asserting on the snapshot refs and on page state read back with
    `eval`. Gated on `BOWSER_E2E=1`, forced to `BOWSER_BACKEND=webkit`,
    skipped off macOS.
  - `tests/e2e-compat.test.ts`: differential test. When `playwright-cli` is in
    `$PATH` with its WebKit installed, run the same todo flow with both tools
    against the same fixture and assert that every ref bowser reports
    (role + name) exists in `playwright-cli`'s tree, before and after the
    flow. Skips cleanly otherwise. (`/opt/homebrew/bin/playwright-cli` 0.1.13
    is present on the owner's machine; the 2026-04-26 design planned this
    test and it was never built.)
  - `test.yml`: an `e2e (WebKit, macOS)` job on `macos-latest` running the
    WebKit suites and the compiled-binary smoke, alongside the existing
    Chromium job.
  - The layer test skeleton with the rules that already hold today; later
    PRs add rules as the layout changes. The `OP_META` table and its key test
    belong to PR 6, which introduces urgent routing; PR 2 declares the op map
    only.
- **Existing tests move, they are not rewritten.** Import paths change.
  Expected strings change only where a command's output changes on purpose
  (see "The contract"), and each such change is a separate commit in its PR.
  `fakeClient` is retyped from `DaemonOps`.
- **Registry drift test.** Every command has a summary, appears in README and
  SKILL.md, and (via the compiler) has a handler.
- **Per-PR gate.** Before each PR of the series is opened:
  `bun run typecheck`, `bun test`, `BOWSER_E2E=1 bun test` on WebKit, and
  `BOWSER_E2E=1 BOWSER_BACKEND=chrome bun test` with the bowser-managed
  Chromium. Any PR touching `cli.ts` or `daemon/client.ts` also builds the
  binary with `bun build --compile` and runs `open` / `snapshot` / `close`
  through it, because `bun test` masks spawn and `unref` regressions.
- **Series gate.** After the last PR, a dogfooding pass on the compiled binary
  on WebKit, modeled on the 10-scenario report in issue #7: a login form, a
  multi-step todo flow, a `select`/`check` form, history navigation, storage
  round-trips, a screenshot, `close --all`, and an MCP session driven by a
  real client. Findings go into a dated report under `docs/superpowers/`, and
  anything that regressed against `playwright-cli` blocks the release.

## Section 6 — PR series

Each PR is green on its own, including the WebKit e2e suites from PR 1.

| # | PR | Touches | Visible change |
| --- | --- | --- | --- |
| 1 | Typecheck gate and its three fixes; WebKit title fix; WebKit e2e coverage; `playwright-cli` differential test; macOS e2e CI job; layer test skeleton | `tests/`, `test.yml`, `package.json`, `browser.ts`, `daemon.ts` | `open` on WebKit prints the real title |
| 2 | Typed protocol; split `daemon.ts` into `daemon/{protocol,server,client,main}.ts`; retype `fakeClient` | daemon, tests | none |
| 3 | `Browser` absorbs cookies and native history; `backend.ts` split out; `requires: "cdp"` gate | browser, daemon/server | none (error text preserved) |
| 4 | `commands/*` split, `context.ts` helpers, `page-scripts.ts` | commands, tests imports | output wording may move closer to `playwright-cli`; CHANGELOG |
| 5 | Registry: dispatch, HELP, MCP from `COMMANDS`; delete `schemas.ts` body, `DESCRIPTIONS`, `MCP_EXCLUDED`; docs drift test | cli, mcp, tests | `--help`, MCP descriptions; CHANGELOG |
| 6 | Event lane: `OP_META`, urgent routing, `DaemonState`, `subscribe()` | daemon/server, browser | none |
| 7 | CLAUDE.md: new "Where to look first", "Adding a command" is four steps, drop gotchas the compiler now enforces | docs | none |
| — | Series gate: dogfooding pass on the compiled binary on WebKit (Section 5) | report only | none |

PR 7 may be folded into 5 or 6. PRs 2 and 3 produce the types that 4 and 5
lean on; 6 is last because it is the only one whose shape is set by a feature
not yet built.

## Findings from probing `playwright-cli` 0.1.13 (2026-09-05)

Both tools were run against `tests/fixtures/todo-app.html`, bowser on WebKit.

- **The snapshot formats differ in content, not just syntax.** `playwright-cli`
  prints the full accessibility tree: headings, text nodes, generic
  containers, list items, every node with a ref, plus attributes such as
  `[active]`, `[level=1]`, `[cursor=pointer]` and `/placeholder:` children,
  wrapped in a markdown block with `### Page`, URL, title and a ```` ```yaml ````
  fence. Bowser prints only interactive elements under landmarks, as bare
  YAML, with `- role "name": [ref=eN]` (colon before the ref). An agent on
  bowser cannot read "0 items left" from a snapshot; it needs `eval`.
  **Decision:** freeze bowser's format for this refactor. "Full aria tree in
  `playwright-cli` 0.1.x format" is the first backlog item after the series,
  ahead of `dialog-*`, because it affects every agent turn.
- **`open` reports an empty title on WebKit.** Fixed in PR 1 (Section 5).
- **`tsc` fails today** with three errors nobody sees, because `bun test`
  does not typecheck. Fixed in PR 1.
- **`goto` immediately after `reload` fails on WebKit** with `NSURLErrorDomain
  error -999`: `reload` resolves before its navigation commits, so the next
  `navigate` cancels it (a 50 ms gap passes every time). Deterministic. Kept
  visible as a `test.todo` in `tests/e2e-webkit.test.ts`; fixed in PR 3 when
  `Browser` adopts native history (Section 4 open question).
- **`press` dispatches no bubbling `keydown` on WebKit**: `Bun.WebView.press("Enter")`
  submits the form natively but no `keydown` listener on `document` fires. A
  Bun/WebKit limitation bowser cannot fix; kept visible as a `test.todo`.
- **`playwright-cli install-browser webkit` hung twice** on the owner's
  machine (extraction stalls at 0 % CPU; disk 97 % full). The differential
  test therefore ran only its skip path locally; the parsers were verified by
  hand against captured output. Retry after freeing disk space.
- **Native history does not fix stale URLs by itself (2026-09-06 probe, Bun 1.4.0).**
  `goBack()`/`goForward()` resolve immediately, like the `history.back()` emulation;
  `onNavigated` fires ~2 ms later and `url` updates within ~25 ms. `click()` resolves ~30 ms
  before its navigation commits. PR 3 adds a navigation watch in `Browser` (wait for a
  navigation that begins within 100 ms, up to 10 s). Native `reload()` also resolves
  immediately; the `-999` failure went away once `reload` waited for its navigation
  through the same watch. The runtime methods are `goBack`/`goForward`; `@types/bun`
  declares `back`/`forward`.

### Bun.WebView event mechanisms (2026-09-06)

Probed directly (Bun 1.4.0, macOS arm64) while building PR 6; these correct
Section 4 where it guessed.

1. **`view.addEventListener(<CDP event name>, handler)` works on the chrome backend.** After `await v.cdp("Page.enable", {})`, clicking a button that calls `confirm()` fires the listener registered for `"Page.javascriptDialogOpening"`. The event object's own enumerable key is only `isTrusted`; the CDP parameters arrive on **`e.data`**, and `e.type` is the event name. Observed `e.data` for a `confirm`: `{ url, frameId, message: "sure?", type: "confirm", hasBrowserHandler: false, defaultPrompt: "" }`.
2. **On the webkit backend `addEventListener` accepts the registration and never throws — and never fires.** So a `subscribe()` that feature-probed `typeof view.addEventListener === "function"` would return `true` on webkit and be a lie. It must branch on the backend kind.
3. **`onNavigated` / `onNavigationFailed` are assignable properties, not `addEventListener` events, and `wrapView` already owns both** (`src/browser.ts`, the navigation watch). `subscribe()` must not touch them: assigning over either would silently break the false→true `loading` transition detection that PR 3 added.
4. CDP parameter naming differs from the spec's sketch: CDP sends `defaultPrompt`, the spec's `DaemonState` sketch wrote `defaultValue`.

## Backlog notes raised during design (not part of this refactor)

- **Persistent session profile on WebKit.** `Bun.WebView` accepts
  `dataStore: { directory }` (WebKit needs macOS 15.2+). A `--persistent`
  flag or env var pointing it at `~/.bowser/sessions/<name>/profile` would
  keep logins across daemon restarts. One change in `openBrowser`; fits the
  post-refactor layout as-is. Does not and cannot share Safari's or Chrome's
  own profile.
- **`fill --stdin`** so a secret from `op read` never appears in process
  arguments. Trivial once the registry exists.

## Open questions

- Whether `Bun.WebView` creates a new instance on `window.open` from the page,
  or the popup is lost. Not needed for this refactor; decides how tabs are
  designed later. Answer by experiment when tabs are scheduled.
- (Answered in PR 3, see Findings.) Native `goBack()` resolves on the same event as the
  emulation; the fix was a navigation watch, not the native call.
- How dialogs can be surfaced on WebKit at all (Section 4 caveat). Not
  blocking this refactor; blocking the dialog task.
- Which bowser-specific output strings, if any, are worth changing toward
  `playwright-cli` wording in PR 4. The default is to leave wording alone;
  `playwright-cli`'s own result wording is markdown (`### Ran Playwright
  code`), which is not obviously better for a shell agent.
