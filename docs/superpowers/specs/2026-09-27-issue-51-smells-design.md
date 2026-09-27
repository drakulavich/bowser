# Spec: issue #51, the code smells CLAUDE.md used to document

**Status:** approved 2026-09-27. The owner picked issue #51 as the next work after 0.8.0; the do/skip recommendations below are accepted as written.
**Origin:** issue #51. PR #52 cut CLAUDE.md down to lines that trace to a real failure no test or type
check catches. The issue lists 11 smells that the old CLAUDE.md described instead of fixing. Each fix
here either makes the trap impossible or makes a test fail when someone falls into it. Then the
CLAUDE.md line, if one is left, goes.

Every item was checked on `main` at `76ae92a` (released as 0.8.0), with Bun 1.4.2 on macOS.
Measurements used `HOME` set to a temporary directory, pages served by `Bun.serve` on 127.0.0.1, and
either a bare `Bun.WebView` (WebKit backend) or `bun src/cli.ts`.

CLAUDE.md today has five code-trap lines. This spec retires four of them and keeps one, shortened
(item 11):

| CLAUDE.md line | Retired by |
| --- | --- |
| Write to a socket only through `socketWriteAll()` | item 5 |
| A ref command acts on `liveSelector(c, ref)` | item 4 |
| The snapshot walker never reads a password field's value | item 11 (password part) |
| An action that can navigate runs inside `nav.act()` | item 11 (nav part): kept, shortened |
| Resolve a path under `$HOME` inside the function | item 10 |

The other items retire no line: PR #52 already dropped theirs. Two of them fix real bugs (items 3
and 7), and item 11 found a third (select and check that navigate).

## Item 1: the Bun version floor has no drift check

**Status now.** The floor is `>=1.4.2`. It is stated in these places:
- `package.json:15`, `engines.bun`. This is the source. The runtime guard reads it
  (`src/daemon/client.ts:205`), and so does its test (`tests/daemon.test.ts:128`).
- `README.md:33` ("Bun ≥ 1.4.2 must be on your `PATH`") and `README.md:35` (the error text).
- `skills/bowser/SKILL.md:167` and `:170`.
- `.github/workflows/test.yml:23` and `:38`. There are two pins now, not three: P2 (#54) removed the
  `build` job.
- `openspec/config.yaml:7` and `openspec/specs/GLOSSARY.md:13`.

Not floor statements: `README.md:8` ("new in Bun 1.3.12", a fact about `Bun.WebView`), the
`CHANGELOG.md` history, and `bun.lock` (`@types/bun` 1.4.2). The issue's "five places" is out of
date: it is nine lines in six files. No test compares them.

**Proposed fix.** One test in `tests/docs-drift.test.ts`. It reads the floor from `package.json`. In
README.md, SKILL.md, test.yml and the two openspec files, every match of `Bun\s*(≥|>=)\s*[\d.]+` and
of `bun-version:\s*"?>=[\d.]+` must name that floor. Each file must have at least one match, so a
deleted statement fails too.

**Cost.** Small: `tests/docs-drift.test.ts`.
**Value.** A floor bump that misses a file fails `bun test`. No CLAUDE.md line (PR #52 dropped the
old "bumping the floor means updating…" line without a replacement).
**Recommendation.** Do.

FYI, not in scope: `bun-version: ">=1.4.2"` installs the latest Bun, so CI never runs on the floor
itself.

## Item 2: a startup check for `Bun.WebView`

**Status now.** Done in P2 (#54).
- `unsupportedBun` (`src/daemon/client.ts:200-208`) refuses a Bun below `engines.bun` or one where
  `typeof Bun.WebView !== "function"`.
- `connectOrSpawn` calls it before it spawns a daemon (`src/daemon/client.ts:252-253`).
- The message `bowser requires Bun >=1.4.2 (found <v>)` is exit 1 (the `bowser requires (macOS|Bun) `
  branch of the regex at `src/cli.ts:35`).
- `tests/daemon.test.ts:121-157` covers an old Bun and a Bun without `Bun.WebView`.
- README.md:35 and SKILL.md:170 document it.

**Proposed fix.** None. Tick the box on #51.
**Cost / value.** None.
**Recommendation.** Skip: already done.

## Item 3: user errors are classified by a regex over the message

**Status now.** `reportFailure` (`src/cli.ts:33-38`) decides exit 1 or 2 with one regex over the
message text (`src/cli.ts:35`). This has two failure modes.
- A new user error whose text the regex does not know exits 2. Nothing fails.
- An error from the page whose text starts with a known prefix exits 1. Measured:
  ```sh
  bowser eval "(() => { throw 'usage: from the page' })()"     # bowser: usage: from the page   exit=1
  bowser eval "Promise.reject('ref \'e1\' not found anywhere')" # bowser: ref 'e1' not found anywhere   exit=1
  ```
  Both should be exit 2: the page failed, not the user's command line.

Every user error is thrown in the CLI process. None crosses the socket. The throw sites are:
`src/cli.ts:14,22`, `src/cli/parser.ts:86,104,120`, `src/cli/registry.ts:58`, `src/mcp.ts:103`,
`src/state.ts:65,102,108`, `src/daemon/client.ts:180,246,250,253`, `src/commands/context.ts:29,57,70,73`,
`src/commands/navigation.ts:68,81,98`, `src/commands/snapshot.ts:17`, `src/commands/scripting.ts:15,27,30`,
`src/commands/storage-state.ts:45,69`, `src/commands/web-storage.ts:31,47,48,63`,
`src/commands/interaction.ts:26,92,93,102,103,104,120,136,141,160,177`.
A daemon error reaches the CLI as a plain `Error` built from its text (`src/daemon/client.ts:76`).

**Proposed fix.**
1. A leaf module `src/errors.ts` with `export class UserError extends Error {}` and no imports.
2. Each throw site above throws `UserError`.
3. `reportFailure` returns code 1 when `err instanceof UserError`, else 2. The regex goes.
   `withholdingText` and `withPageClient` already keep the error object, so its class survives.
4. Tests:
   - A unit test: a fake daemon whose `evaluate` fails with `usage: from the page` gives code 2.
   - A layer rule in `tests/layers.test.ts`: no `new Error(` in src whose literal starts with
     `usage:`, `unknown `, `expected a ref`, `ref '`, `no open page` or `bowser requires`. It stops a
     new user error from going out as a plain `Error`.
   - The existing `reportFailure(err).code` assertions stay and keep passing.

**Cost.** Medium: one new file, `src/cli.ts`, about 40 throw sites in 13 files, `tests/layers.test.ts`,
one new unit test.
**Value.** Fixes the misclassification above. Exit 1 becomes a property of the throw site. No
CLAUDE.md line (PR #52 dropped the exit-code section).
**Recommendation.** Do.

## Item 4: `loadRef` hands commands a selector they must never use

**Status now.** `Ref.selector` is declared at `src/state.ts:15`. The walker writes it
(`src/page-scripts.ts:469`, `cssPath(el)` for every ref). `loadRef` returns the whole `Ref`
(`src/commands/context.ts:55-59`). Nothing in src reads `target.selector` any more: every ref command
uses `liveSelector` (`src/commands/context.ts:67-76`). The field is dead, and it is the trap.

**Proposed fix.** Delete the field.
- Remove `selector` from `Ref` (`src/state.ts:15`) and from the walker's saved object
  (`src/page-scripts.ts:469`). The walker keeps `cssPath` for `resolveRefScript`.
- Once the field is gone, code that reads `target.selector` fails `bun run typecheck`.
- An old `state.json` that still has the field is read and ignored. `saveState` drops it on the next
  snapshot.
- Tests: about 59 ref literals seed a `selector:` field (`tests/commands.test.ts`,
  `tests/state.test.ts`, `tests/snapshot.test.ts`, `tests/lifecycle.test.ts`, `tests/help.test.ts`,
  `tests/mcp.test.ts`). tsc flags each as an excess property, so none is missed.
  - `tests/state.test.ts:20` asserts the selector. It goes.
  - `tests/commands.test.ts:1098,1133` build the fake page's answers from `r.selector`. They get their
    own map.
  - `tests/e2e-search.test.ts:124` (live net only) reads `searchBox.selector`. It needs another way to
    read the box's value, such as `eval` on a CSS selector it knows.
- One test, in `tests/snapshot.test.ts` or the e2e snapshot test: a saved ref has no `selector` key.
  It fails if someone brings the field back.

**Cost.** Medium: two src lines, then mechanical edits in about seven test files.
**Value.** Retires the `liveSelector` line. Snapshots also stop computing a CSS path per ref that
nobody reads.
**Recommendation.** Do.

## Item 5: no layer rule forbids a raw `socket.write(`

**Status now.** The only raw socket write in src is `src/socket-write.ts:43`. The one other `.write(` is
`process.stdout.write` in `src/mcp.ts:340`, which is a stream, not a Bun socket. Both socket users wire
`drain` (`src/daemon/client.ts:83`, `src/daemon/server.ts:417`). No test says so.

**Proposed fix.** Two rules in `tests/layers.test.ts`:
- Only `src/socket-write.ts` calls `.write(`, except `Bun.write(` and `process.stdout.write(` /
  `process.stderr.write(`.
- A file that calls `Bun.listen(` or `Bun.connect(` has a `drain(` handler.

**Cost.** Small: `tests/layers.test.ts`.
**Value.** Retires the `socketWriteAll()` line.
**Recommendation.** Do.

## Item 6: `onNavigated` / `onNavigationFailed` are single slots

**Status now.** `navigationWatch` assigns both once (`src/browser.ts:174-175`). No other file
assigns them. Only `src/browser.ts` sees the real view: a layer rule already keeps
`new Bun.WebView(` there. A second assignment would silently replace the watch. The daemon's own
listener goes through `Browser.watchNavigation`. No test guards it.

**Proposed fix.** A rule in `tests/layers.test.ts`: across src, `onNavigated\s*=` and
`onNavigationFailed\s*=` each appear exactly once, in `src/browser.ts`.

**Cost.** Small: `tests/layers.test.ts`.
**Value.** A second assignment fails `bun test`. No CLAUDE.md line (PR #52 dropped it).
**Recommendation.** Do. It costs a few lines, and a break here passes every other unit test.

## Item 7: `state` reports the old URL after `history.pushState`

**Status now.** A real bug. `resolveUrl` (`src/browser.ts:43-55`) uses `view.url` when it is not
empty, and reads `location.href` only when it is. `state` (`src/daemon/server.ts:264-268`) is what
`click`, `open`, `goto` and `syncState` report. The snapshot walker reads `location.href` itself
(`src/page-scripts.ts:568`). So after a same-document change the two disagree. Measured through the
CLI:
```sh
bowser open http://127.0.0.1:53411/a
bowser --json click e2       # button calls history.pushState({}, '', '/pushed')
# {"ok":true,"ref":"e2","url":"http://127.0.0.1:53411/a"}           <- old URL
bowser snapshot              # - Page URL: http://127.0.0.1:53411/pushed
```

Measured on a bare `Bun.WebView` (WebKit, Bun 1.4.2), `view.url` against `location.href`:

| Case | `view.url` | `location.href` |
| --- | --- | --- |
| fresh view | `""` | `about:blank` |
| fresh view, first navigate refused (closed port) | `""` | `about:blank` |
| navigate `/a` | `/a` | `/a` |
| `pushState('/pushed?x=1')` | `/a` (stale) | `/pushed?x=1` |
| `replaceState('/replaced')` | `/a` (stale) | `/replaced` |
| hash link `#frag` | `/a` (stale) | `/replaced#frag` |
| `location.hash = 'assigned'` | `/a` (stale) | `…#assigned` |
| `goBack` within the document | `/a` (stale) | `…#frag` |
| link to `/b` | `/b` | `/b` |
| link to a 302 redirect | `/landed?r=1` | `/landed?r=1` |
| pushState, then reload | `/p2` | `/p2` |
| `data:` URL | same | same |
| 404 page | `/404` | `/404` |
| navigate refused (closed port) or DNS failure from a page | old page | old page |
| slow `navigate`, 300 ms in (`loading` true) | old page | old page |

They differ only after a same-document change, and there `location.href` is right. `view.title` was
`""` in every case, so `realTitle` already evaluates `document.title` on every `state`.

**Proposed fix.** `realUrl` reads `location.href` always. It falls back to `view.url` when the read
throws or gives no non-empty string.
- `assertNavigated` (`src/commands/navigation.ts:18-22`) still works. A first navigation that never
  commits leaves the page at `about:blank`, and both sources say so (table rows 1-2).
- The fresh session still reports `about:blank`.
- A stuck page costs nothing new: `state` already evaluates the title on every call. The URL and title
  can share one evaluate (`[location.href, document.title]`), so `state` makes one page call instead
  of two.
- Tests:
  - `tests/resolve-url.test.ts` changes: `location.href` wins over a non-empty `view.url`. The current
    "returns view.url unchanged when it is set (no evaluate)" test inverts.
  - An e2e test in `tests/e2e-actions.test.ts`: `click` on a pushState button replies with the new
    URL, and `state.json` holds it.

**Cost.** Small: `src/browser.ts`, `src/page-scripts.ts` (one read script), two test files.
**Value.** Fixes the bug. `click`'s reply, `state.json` and `snapshot` agree.
**Recommendation.** Do.

## Item 8: `ViewLike` names `goBack`/`goForward` against `@types/bun`

**Status now.** `ViewLike` declares `goBack?()` and `goForward?()` as optional
(`src/browser.ts:34-37`). `bun-types` 1.4.2 declares `back()` and `forward()`
(`node_modules/bun-types/bun.d.ts:9697-9699`). Measured at runtime: `goBack` and `goForward` are
functions; `back`, `forward` and `stop` are `undefined`. `wrapView` probes with `typeof` and falls back
to `history.back()` / `history.forward()` (`src/browser.ts:311-318`). If someone renames both
`ViewLike` and the call sites to `back`/`forward`, tsc passes. At runtime the probe fails, and the
fallback hides it: the e2e go-back test (`tests/e2e-webkit.test.ts:157`) still passes.

**Proposed fix.**
- Make `goBack` and `goForward` required in `ViewLike`, and delete the fallback, along with
  `HISTORY_BACK` and `HISTORY_FORWARD` in `src/page-scripts.ts:673-674`.
- `openBrowser` passes the real view to `wrapView`. Since `bun-types` lacks the names, add a module
  augmentation: `declare module "bun" { interface WebView { goBack(): Promise<void>; goForward(): Promise<void> } }`.
  Not confirmed that tsc merges this with the `WebView` class. If it does not, use one narrow cast in
  `openBrowser`, with the comment.
- Then a rename to `back` breaks loudly. Renaming only the call sites fails tsc. Renaming `ViewLike`
  and the augmentation too throws `view.back is not a function`, and the e2e go-back test fails.
- `tests/browser.test.ts:277-286` (the fallback test) goes. The `reload` fallback stays: `reload` is
  named right in the types.

**Cost.** Small: `src/browser.ts`, `src/page-scripts.ts`, one declaration, `tests/browser.test.ts`.
**Value.** A wrong name fails a test, not silently. No CLAUDE.md line (PR #52 dropped it; the
`ViewLike` comment stays).
**Recommendation.** Do.

## Item 9: `looksLikeOurDaemon` identifies a daemon by its last two argv words

**Status now.** `looksLikeOurDaemon` (`src/daemon/pidfile.ts:29-45`) wants the session as the last
word and `…/src/daemon/main.ts` (or `bowser … --daemon`, for 0.7-or-older binaries) just before it.
`spawnDaemon` builds `[execPath, <pkg>/src/daemon/main.ts, session]` (`src/daemon/client.ts:301`), and
the profile travels as `BOWSER_DAEMON_PROFILE` (`src/daemon/client.ts:210-213`). P2 kept this form
on purpose, so that `close` still ends daemons started by older releases.

The trap is real, but no test covers it. Suppose the profile moves to argv, after the session. The
spawned daemon no longer passes `isOurDaemon`. `claimSession` then treats a live daemon's pidfile as
stale (`src/daemon/pidfile.ts:103`), and `close` refuses to signal it. No current test spawns with a
profile and then races a claim or makes `close` use its fallback, so nothing would fail.

**Proposed fix.** Keep the identification as it is. Only pin the round trip:
- Move the argv into an exported `daemonCommand(session)` in `src/daemon/client.ts`.
- One unit test in `tests/daemon.test.ts`: `looksLikeOurDaemon(daemonCommand(s).join(" "), s)` is
  true.

Changing how daemons are identified (a token in the pidfile, say) is skipped. `close` would have to
know both forms for as long as old daemons may run, which is the cost P2 already declined.

**Cost.** Small: `src/daemon/client.ts`, `tests/daemon.test.ts`.
**Value.** A spawn line that the identifier cannot read fails `bun test`. The "env rather than argv"
comment becomes a test.
**Recommendation.** Do the test. Skip the redesign.

## Item 10: "resolve under $HOME at call time" has no test

**Status now.** `sessionsRoot` and `profilesRoot` read `process.env.HOME` inside the function
(`src/state.ts:36-45`). They are the only readers of `HOME` or `homedir()` in src. Tests redirect
`HOME` in `beforeAll` in 28 files. A module-level constant would fail none of them: they would just
write to the real `~/.bowser`.

**Proposed fix.**
- A unit test in `tests/state.test.ts`: set `HOME` to A, read `sessionsRoot()` and `profileDir("x")`;
  set it to B, read again. Both follow `HOME`.
- A rule in `tests/layers.test.ts`: only `src/state.ts` mentions `process.env.HOME` or `homedir(`. A new
  module that needs a home path has to go through `state.ts`.

**Cost.** Small: `tests/state.test.ts`, `tests/layers.test.ts`.
**Value.** Retires the `$HOME` line.
**Recommendation.** Do.

## Item 11: the password-read and `nav.act` rules

These are invariants over code that does not exist yet. A test can only enforce them where they meet
a list or a name it can check.

### Password reads

**Status now.** The walker (`SNAPSHOT_SCRIPT`) reads `el.value` in five places, each guarded by
`isPassword` on its own line or the line before (`src/page-scripts.ts:317-318`, `:327`, `:343`,
`:471`, `:496-497`). `tests/e2e-password.test.ts` checks the known paths: the value child, the saved
ref's `value`, and names built through `aria-labelledby`. A new read on a new path would pass it.

**Proposed fix.**
- One accessor in the walker, `valueOf(el)`, that returns `''` for a password field and `el.value`
  otherwise. The five reads use it.
- A test in `tests/page-scripts.test.ts`: `SNAPSHOT_SCRIPT` has exactly one `.value` read that is not an
  assignment and not `getAttribute('value')`, and it is inside `valueOf`.

What it catches: a new `x.value` read anywhere in the walker. What it misses: `el['value']`,
`Reflect.get`, `FormData`, and `getAttribute('value')` (the attribute holds a password field's
initial value from the HTML). Those are unlikely by accident, and the e2e test stays for the known
paths.

**Cost.** Small: `src/page-scripts.ts`, `tests/page-scripts.test.ts`.
**Value.** Retires the password line.
**Recommendation.** Do.

### `nav.act`

**Status now.** `click`, `press`, `back`, `forward` and `reload` run in `nav.act`
(`src/browser.ts:289-325`). `type`, `hover`, `select` and `setChecked` do not. `select` and
`setChecked` run page scripts that fire `change`, and a page handler can navigate on it. That is a
real bug, measured through the CLI with a `<select onchange="location.href='/next'">` and a checkbox
with the same handler, where `/next` answers after 1.5 s:
```sh
bowser select e3 b     # selected e3 -> "b"
bowser snapshot        # - Page URL: http://127.0.0.1:53412/a      <- old page
# 2 s later:  - Page URL: http://127.0.0.1:53412/next
bowser check e5        # checked e5
bowser snapshot        # - Page URL: http://127.0.0.1:53412/a      <- old page
```
`type` was measured too: `view.type("abc\n")` and `"abc\r"` in a one-field form did not submit it.

**Proposed fix.**
- Every op in the daemon's `ACTS` set (`src/daemon/server.ts:352`: click, type, press, hover, select,
  check, uncheck) runs its `Browser` method inside `nav.act`. That is `select`, `setChecked` and
  `hover` in `wrapView`, plus `type` for uniformity.
- A table test in `tests/browser.test.ts`: for each `ACTS` op, the `Browser` method arms the watch.
  The fake view records an `evaluate(NAV_ARM)` before the action. This needs `ACTS` exported, or moved
  to `src/daemon/protocol.ts`.
- An e2e test in `tests/e2e-actions.test.ts`, with the slow-navigation page above: `select` and
  `check` followed by `snapshot` report `/next`.

What it catches: an `ACTS` op whose method skips `nav.act`. What it misses: a new op that acts on the
page but is left out of `ACTS`. That op would also miss the dialog shim, so the next `ACTS` bug
report tends to find it. No test can decide in general whether an action "can navigate".

Cost to users: `nav.act` adds the grace window (100 ms) and two cheap evaluates to each `hover`,
`select`, `check`, `uncheck` and `type` that does not navigate. The owner may exempt `type` and
`hover`. The table test then lists the exemptions by name.

**Cost.** Small to medium: `src/browser.ts`, `src/daemon/server.ts` (export), `tests/browser.test.ts`,
`tests/e2e-actions.test.ts` and a fixture.
**Value.** Fixes stale pages after `select` and `check`. The CLAUDE.md line shrinks to what the test
cannot see: "An op that acts on the page belongs in `ACTS` (`src/daemon/server.ts`)."
**Recommendation.** Do.

## Tasks

Four tasks, in this order. Each is one PR, or one commit on this branch.

1. **Rules and drift checks (items 1, 5, 6, 9, 10).** Tests only, plus `daemonCommand` in
   `src/daemon/client.ts`. Adds rules to `tests/layers.test.ts`, the floor check to
   `tests/docs-drift.test.ts`, and the unit tests in `tests/state.test.ts` and `tests/daemon.test.ts`.
   First: it changes no behaviour, and every rule it adds holds on today's main.
2. **`browser.ts` behaviour (items 7, 8, 11 nav part).** `realUrl` reads `location.href`; `goBack` and
   `goForward` become required with no fallback; `ACTS` ops run in `nav.act`. They all touch `wrapView`
   and `tests/browser.test.ts`, so one implementer does them together. The e2e tests go in
   `tests/e2e-actions.test.ts`.
3. **Typed user errors (item 3).** `src/errors.ts`, every throw site, `reportFailure`, one layer rule.
   It touches many command files, so it goes after Task 2 has landed.
4. **Refs and the walker (items 4, 11 password part).** Drop `Ref.selector`, add `valueOf` to the
   walker, update the test literals. Last: it touches `context.ts` and `interaction.ts` next to
   Task 3's throw sites, and its test edits are mechanical once those settle.

## Acceptance

- Every new test goes through a public seam: `run()` / `reportFailure`, the `cmd*` functions with
  `fakeClient`, `wrapView` with a fake view, `connectOrSpawn`, the exported page scripts, or the CLI in
  an e2e test. The layer and drift rules read source and docs as text, as the existing ones do.
- Each fix fails at least one test when it is reverted:
  - item 1: change the floor in README.md only, and `tests/docs-drift.test.ts` fails;
  - item 3: throw a plain `Error("usage: …")`, and the layer rule fails; the page-thrown `usage:`
    test fails while the regex is still there;
  - item 4: add `selector` back to `Ref`, and the no-`selector` snapshot test fails; read
    `target.selector`, and tsc fails;
  - item 5: add a raw `socket.write(` in `server.ts`, or drop a `drain`, and the layer test fails;
  - item 6: assign `view.onNavigated` a second time, and the layer test fails;
  - item 7: restore the `view.url`-first order, and the resolve-url and e2e pushState tests fail;
  - item 8: rename `goBack` to `back` in `ViewLike` and the augmentation, and the e2e go-back test
    fails;
  - item 9: append an argument after the session in `daemonCommand`, and the round-trip test fails;
  - item 10: make `sessionsRoot` a module-level constant, and the state test fails;
  - item 11: add an unguarded `el.value` read to the walker, and the page-scripts test fails; take
    `select` out of `nav.act`, and the browser table test and the e2e test fail.
- `bun run typecheck`, `bun test` and `BOWSER_E2E=1 bun test` pass.
- CLAUDE.md loses these lines:
  - "Write to a socket only through `socketWriteAll()`…" (item 5);
  - "A ref command acts on `liveSelector(c, ref)`…" (item 4);
  - "The snapshot walker never reads a password field's value…" (item 11);
  - "Resolve a path under `$HOME` inside the function…" (item 10).

  And this one is replaced: "An action that can navigate runs inside `nav.act()`…" becomes "An op that
  acts on the page belongs in `ACTS` (`src/daemon/server.ts`); a test then holds it to `nav.act` and
  the dialog shim." (item 11).
- #51's boxes are ticked, item 2 with a pointer to #54.
- CHANGELOG gets a Fixed entry for items 3, 7 and 11 (the three user-visible bugs).

## Out of scope

- Changing how daemons are identified (item 9's redesign).
- Running CI on the exact floor Bun rather than the latest (item 1's FYI).
- A general check that an action "can navigate" (item 11). Only the `ACTS` list is enforced.
- Password reads through `el['value']`, `Reflect.get`, `FormData` or `getAttribute('value')` in the
  walker (item 11).
- The `reload` fallback in `wrapView`. `reload` is named right in the types.
- iframe, shadow DOM and other snapshot gaps listed in the snapshot spec.
