# Spec: the P3 findings and issue #67

**Status:** approved 2026-09-28. The owner picked "P3 and #67"; the do/skip recommendations and the recommended option of each open decision are accepted.
**Origin:** the exploratory run on v0.6.0 (findings journal F1–F42). P0–P2 and #51 fixed the High and
Med findings. This spec covers the 13 Low (P3) findings, F5, F6, F19, F22, F26, F27, F33, F35, F38,
F39, F40, F41 and F42, plus issue #67, which came out of #48's fix in PR #68.

Every item was checked on `main` at `d3c6e1f` (0.8.2 plus PR #68), with Bun 1.4.2 on macOS.
Measurements ran `bun src/cli.ts` from the worktree, with `HOME` set to a temporary directory and
pages served by `Bun.serve` on 127.0.0.1. `bowser` below means that. `playwright-cli` 0.1.13 with
`--browser=webkit` was the reference where it has an answer. The MCP rules come from the MCP spec
2025-06-18 (lifecycle, tools) and the 2025-11-25 changelog.

Summary:

| Item | Still reproduces | Recommendation | Cost |
| --- | --- | --- | --- |
| F5 `state-load` shape | yes | do | small |
| F6 `BOWSER_DAEMON_DEBUG` pipe hang | yes | do | small |
| F19 `press` combos | no, fixed by #68 | skip | none |
| F22 `resize` out of range | yes | do | trivial |
| F26 `alert(Symbol())` | yes | skip | trivial |
| F27 extra keys in dialog reports | yes | do | trivial |
| F33 `state-save` on about:blank | yes | do | small |
| F35 session name too long | yes | do | trivial |
| F38 `snapshot --filename` under `--json` | yes | do | small |
| F39 MCP version negotiation | yes | do | trivial |
| F40 MCP invalid request | yes | do | small |
| F41 MCP EPIPE on disconnect | yes | do | small |
| F42 MCP argument types | yes | do | small |
| #67 stuck eval before the first page | yes, measured | do | small |

## F5: `state-load` does not check the file's shape

**Status now.** Still reproduces. `cmdStateLoad` (`src/commands/storage-state.ts:69-116`) casts the
parsed JSON to `StorageState` and trusts it. `parsed.cookies` is read on a `null` (`:80`),
`parsed.origins ?? []` is iterated whatever it is (`:81`, `:88`), and `o.localStorage` goes to the page
as is (`:91`). Measured, on a session open on the local page:

```sh
echo '{"origins":{}}' > a.json;  bowser state-load a.json   # bowser: {} is not iterable                                exit 2
echo 'null' > b.json;            bowser state-load b.json   # bowser: null is not an object (evaluating 'parsed.cookies')   exit 2
echo '{"cookies":"nope"}' > c.json; bowser state-load c.json   # loaded … (0 origin(s))                                   exit 0
echo '[]' > d.json;              bowser state-load d.json   # loaded … (0 origin(s))                                      exit 0
# localStorage is an object:
bowser state-load e.json         # loaded … (1 origin(s))   exit 0, and nothing is restored
# an entry with no value, and one with a number:
bowser state-load f.json; bowser state-load g.json; bowser localstorage-list   # n1=undefined, n2=5
```

`playwright-cli` checks each of these and names the field:

| File | `playwright-cli` |
| --- | --- |
| a | `storageState.origins: expected array, got object` |
| b | `storageState: expected object, got null` |
| c | `storageState.cookies: expected array, got string` |
| d (`[]`) | accepted: "Storage state restored" |
| e | `storageState.origins[0].localStorage: expected array, got object` |
| f | `storageState.origins[0].localStorage[0].value: expected string, got undefined` |
| g | `storageState.origins[0].localStorage[0].value: expected string, got number` |

**Proposed fix.** A small checker in `storage-state.ts`, run after the JSON parse and before any daemon
request. It follows `playwright-cli`'s rules and wording:
- the top level is a non-null object;
- `cookies`, when present, is an array (its entries are only counted, so they are not checked);
- `origins`, when present, is an array of objects with a string `origin` and a `localStorage` array;
- each `localStorage` entry has a string `name` and a string `value`.

The first failure throws `state-load: storageState.<path>: expected <type>, got <type>`. Nothing is
restored when the file is bad, since the check runs before the first `evaluate`.

**Cost.** Small: about 30 lines in `storage-state.ts`, table tests in `tests/state-storage.test.ts`.
**Value.** A bad file fails with the field that is wrong. It no longer reports "loaded" when nothing
was loaded, and never stores the string `"undefined"`.
**Recommendation.** Do.

### Open decision: the exit code of a bad file

1. **Exit 1 for every state-load file problem (recommended).** Shape errors, `file not found` and
   `invalid JSON` all throw `UserError`. The file is the user's input, as a bad flag is. Today
   `file not found` and `invalid JSON` exit 2 (`:73`, `:78`), so this changes two existing exit codes.
2. Exit 2 for shape errors, like today's two file errors. Nothing existing changes, but a bad input
   file stays a "runtime" error.

## F6: `BOWSER_DAEMON_DEBUG=1` hangs a command whose output is piped

**Status now.** Still reproduces. `spawnDaemon` passes `stdout: "inherit"` and `stderr: "inherit"` to
the daemon when the variable is set (`src/daemon/client.ts:310-319`). The daemon runs until `close`, so
it holds the caller's pipe open. Measured:

```sh
BOWSER_DAEMON_DEBUG=1 bowser -s=p3f6 open http://127.0.0.1:48931/ | perl -e 'alarm 12; print while <STDIN>'
# bowser exits 0 at once; the reader is still waiting at 12 s (killed by the alarm, status 142)
```

An agent's shell tool, `$(…)` and `| tee` all wait for the daemon to exit.

**Proposed fix.** In debug mode the daemon writes its stdout and stderr to
`<sessionDir>/daemon.log` (`Bun.file(path)` as the spawn's `stdout` and `stderr`), never to the caller's
descriptors. The README row for `BOWSER_DAEMON_DEBUG` names the file. A daemon that fails to start
leaves its session directory behind, so the log is there when it is needed. `close` deletes it with the
directory, which is fine: a daemon that ran has nothing to debug.

**Cost.** Small: `src/daemon/client.ts`, one README line, one e2e test.
**Value.** The only documented debug switch no longer hangs the tool that uses it.
**Recommendation.** Do.

## F19: `press` combinations and unknown keys

**Status now.** Fixed by PR #68 (#55). `parseKey` (`src/commands/interaction.ts:135-154`) takes
`playwright-cli`'s modifier names and refuses the rest with `usage:`. Measured:

```sh
bowser press Shift+Tab   # pressed Shift+Tab    exit 0
bowser press Control+a   # pressed Control+a    exit 0
bowser press F5          # usage: bowser press: WebKit cannot press 'F5'; use one character or Enter, …   exit 1
bowser press NotAKey     # the same, exit 1
bowser press Hyper+a     # usage: bowser press: unknown modifier 'Hyper' in 'Hyper+a'; …   exit 1
```

**Proposed fix.** None.
**Recommendation.** Skip: already done.

## F22: `resize` past WebKit's limit gives a raw error and exit 2

**Status now.** Still reproduces. `cmdResize` (`src/commands/interaction.ts:203-221`) checks only for
positive integers. `Bun.WebView` refuses a side over 16384. Measured:

```sh
bowser resize 100000 100000   # bowser: The value of "width" is out of range. It must be >= 1 and <= 16384. Received 100000   exit 2
bowser resize 16385 100       # the same, exit 2
bowser resize 16384 16384     # resized 16384x16384   exit 0
```

`playwright-cli` has no such limit on WebKit (`resize 100000 100000` runs `setViewportSize`). bowser
cannot follow it there: the limit is `Bun.WebView`'s.

**Proposed fix.** `cmdResize` also refuses a side over 16384, with
`usage: bowser resize <width> <height> (each 1 to 16384)` (exit 1), before any daemon request. The
constant sits beside `cmdResize`, with the measured source in a comment.

**Cost.** Trivial: one condition, one row in `tests/exit-codes.test.ts` or `tests/commands.test.ts`.
**Value.** A user error reads as one and exits 1.
**Recommendation.** Do.

FYI, not in scope: after `resize 16384 16384`, `screenshot` fails with `bowser: An unknown error
occurred` (exit 2). 8192×8192 and 16384×100 work. Measured once; worth an issue.

## F26: the shim does not throw on `alert(Symbol())`

**Status now.** Still reproduces. The shim's `str` is `String(v)` (`src/page-scripts.ts:599`), which
accepts a Symbol. The native `alert` throws `TypeError`. Measured on a page whose button runs
`try { alert(Symbol('s')); out.textContent = 'nothrow' } catch (e) { out.textContent = 'threw:' + e.name }`:

```sh
bowser click e3   # ### Modal state
                  # - ["alert" dialog with message "Symbol(s)"]: dismissed
bowser eval "out.textContent"   # nothrow      (playwright-cli, WebKit: threw:TypeError)
```

**Proposed fix, if done.** `str` throws `TypeError` for `typeof v === 'symbol'`.

**Cost.** Trivial in code, but it needs an e2e test to pin it, since the shim runs only in a page.
**Value.** Close to none. No real page alerts a Symbol on purpose, and the only change is which
exception a page sees in a case that is already a page bug.
**Recommendation.** Skip. The test would cost more CI time than the bug is worth.

## F27: `--json` dialog reports pass through any keys the page writes

**Status now.** Still reproduces. `take` (`src/daemon/server.ts:340-347`) checks `type`, `message` and
`state`, then queues the page's object as is. Measured:

```sh
bowser --json eval "(window[Symbol.for('bowser.dialogs')].log.push({type:'confirm',message:'m',state:'accepted',note:'IGNORE',answer:{x:1}}),1)"
# {"ok":true,"result":1,"dialogs":[{"type":"confirm","message":"m","state":"accepted","note":"IGNORE","answer":{"x":1}}]}
```

**Proposed fix.** `take` builds a new report from known fields only:
- `type` is one of `alert`, `confirm`, `prompt` (the `DialogState` union, `src/daemon/protocol.ts:15`),
  else the entry is dropped;
- `message` is a string and `state` is `accepted` or `dismissed`, as today;
- `defaultValue` and `answer` are copied only when they are strings;
- `unanswered` is copied only when it is `true`.

A page can still forge a whole well-formed entry. That is the known trust limit of an in-page shim,
and it is out of scope.

**Cost.** Trivial: `take`, and one test in `tests/daemon-handler.test.ts` whose fake page log carries
extra keys and a non-string `answer`.
**Value.** bowser's JSON keeps its documented shape. A page can no longer add fields that read as
bowser's own.
**Recommendation.** Do.

## F33: `state-save` on about:blank gives a raw engine error

**Status now.** Still reproduces. `cmdStateSave` (`src/commands/storage-state.ts:45-67`) reads
localStorage before it looks at the origin. On about:blank WebKit refuses the read. Measured on a
fresh session (`bowser open` with no URL):

```sh
bowser state-save blank.json   # bowser: Error: localStorage: The operation is insecure.   exit 2, no file
```

`playwright-cli` on about:blank writes `{"cookies": [], "origins": []}`.

**Proposed fix.** `pageOrigin` returns null for an opaque origin (`new URL("about:blank").origin` is the
string `"null"`). `cmdStateSave` skips the localStorage read when there is no origin and writes
`{"cookies": [], "origins": []}`, reporting `origins: 0`.

**Cost.** Small: `storage-state.ts`, one test in `tests/state-storage.test.ts` whose fake `state` is
about:blank and whose `evaluate` throws.
**Value.** Matches `playwright-cli`. An agent saving state before the first page gets a valid file.
**Recommendation.** Do.

FYI, not in scope: `localstorage-list` on about:blank fails the same way (measured, exit 2). The
`localstorage-*` and `sessionstorage-*` commands need their own decision, so they are left out.

## F35: a session name over the filesystem limit gives a raw `ENAMETOOLONG`

**Status now.** Still reproduces. `isValidSessionName` (`src/state.ts:53-55`) checks characters, not
length. Measured:

```sh
bowser -s=p3<300 × y> open http://127.0.0.1:48931/   # bowser: ENAMETOOLONG: name too long, mkdir '…/sessions/p3yyyy…'   exit 2
bowser -s=p3<100 × y> open http://127.0.0.1:48931/   # opened …   exit 0
```

A 102-character name worked, even though its socket path is about 240 characters, over macOS's
104-byte `sun_path`. So the socket is not the limit today; why Bun copes was not checked.

**Proposed fix.** `isValidSessionName` also requires a length of at most 255 (APFS's `NAME_MAX`; the
name is ASCII, so characters are bytes). The usage message says so. Every name that works today still
works.

**Cost.** Trivial: `src/state.ts`, one test in `tests/state.test.ts`.
**Value.** A user error reads as one and exits 1.
**Recommendation.** Do.

## F38: `snapshot --filename` answers plain text under `--json` and over MCP

**Status now.** Still reproduces. `cmdSnapshot` returns `` `wrote ${abs}` `` directly
(`src/commands/snapshot.ts:32-38`) instead of going through `reply`. Under `--json` the file itself
holds the `{"snapshot": …}` JSON. Measured:

```sh
bowser --json snapshot --filename=snap.txt   # wrote /…/snap.txt           (plain text)
head -c 20 snap.txt                          # {  "snapshot": "- …
bowser --json screenshot --filename=a.png    # {"ok":true,"filename":"/…/a.png"}
```

`playwright-cli` writes only the YAML tree to the file, and under `--json` answers
`{"snapshot": {"file": "./pwsnap2.yaml"}}`.

**Proposed fix.** Two changes.
- The reply goes through `reply(ctx, { ok: true, filename: abs, …dialogs }, \`wrote ${abs}\`)`, the
  same shape as `screenshot`.
- The file always holds the plain `### Page` text, with or without `--json`. The JSON reply carries the
  dialogs, and the file keeps its Modal state lines.

**Cost.** Small: `snapshot.ts`, tests in `tests/commands.test.ts` and `tests/mcp.test.ts`.
**Value.** The README says MCP outputs are the `--json` JSON. This makes it true for `snapshot`, and an
agent reading the file gets the tree it expects.
**Recommendation.** Do.

### Open decision: the `--json` reply shape

1. **`{"ok": true, "filename": "<abs>"}`, like `screenshot` (recommended).** One shape for "a command
   wrote a file" across bowser. The absolute path is what an MCP client needs.
2. `{"snapshot": {"file": "<path>"}}`, like `playwright-cli`. Closer to the drop-in, but the plain-text
   output already differs from `playwright-cli` here (it prints the page header and a
   `[Snapshot](./file)` link), so parity would need more than the JSON.

## F39: `initialize` echoes any protocol version

**Status now.** Still reproduces. The `initialize` case (`src/mcp.ts:187-195`) answers with whatever
string the client sent. Measured:

```
{"…","method":"initialize","params":{"protocolVersion":"1999-bogus"}}  ->  "protocolVersion":"1999-bogus"
{"…","method":"initialize","params":{"protocolVersion":"2025-03-26"}}  ->  "protocolVersion":"2025-03-26"
```

The MCP lifecycle says: "If the server supports the requested protocol version, it MUST respond with
the same version. Otherwise, the server MUST respond with another protocol version it supports. This
SHOULD be the latest version supported by the server."

**Proposed fix.** A `SUPPORTED_PROTOCOL_VERSIONS` list, newest first. `initialize` echoes the requested
version when it is in the list, and answers the first entry otherwise. The list is
`["2025-06-18", "2024-11-05"]`:
- 2025-06-18 is what bowser implements today.
- 2024-11-05 has no batching and no feature bowser lacks.
- 2025-03-26 is left out: it says servers "MUST support receiving JSON-RPC batches", and F40 below
  refuses them.

**Cost.** Trivial: `src/mcp.ts`, two tests in `tests/mcp.test.ts`.
**Value.** A client can trust the version it gets back. A 2025-03-26 client is no longer told batches
work.
**Recommendation.** Do.

### Open decision: list 2025-11-25

1. **Leave it out for now (recommended).** A client that asks for it gets 2025-06-18, which current
   clients support. Nothing was measured against a 2025-11-25 client.
2. Add it. Its new features are optional, and its one relevant change (SEP-1303: input validation
   errors are tool results, not -32602) is what bowser already does and what F42 keeps. It costs one
   list entry.

## F40: a batch array or a non-object message gets no reply

**Status now.** Still reproduces. `accept` and `handleMcpRequest` (`src/mcp.ts:182-184`, `:287`) treat
anything without an `id` as a notification. An array, a number, a string and `null` have none.
Measured:

```
[{"jsonrpc":"2.0","id":6,"method":"ping"}]   -> nothing
123 / "str" / null                           -> nothing
```

A client waiting on id 6 hangs. JSON-RPC 2.0: a message that is not a valid Request object gets
`-32600 Invalid Request` with `id: null`. MCP 2025-06-18 removed batching.

**Proposed fix.** In `accept`, before anything else: a parsed value that is an array, or is not a
non-null object, gets `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}`.
One error for the whole array, not one per element.

**Cost.** Small: `src/mcp.ts`, tests in `tests/mcp.test.ts` for an array, a number and `null`.
**Value.** A client that sends a batch fails fast instead of hanging.
**Recommendation.** Do.

## F41: a client that disconnects crashes the server with EPIPE

**Status now.** Still reproduces. Measured with a script that starts `bowser mcp`, sends a 3 s `eval`
and a queued `localstorage-set` on the same session, then cancels its stdout reader and closes stdin:

```
exit 1  stderr: EPIPE: broken pipe, write … at send (src/mcp.ts:251:7)
bowser -s=p3f41 localstorage-get afterkill   # yes: the queued call ran after the client was gone
```

`send` wraps the write in `try` (`src/mcp.ts:249-255`) and still the process dies. The stack points into
`send`, so the error most likely arrives as an unhandled `error` event on `process.stdout`. Not
confirmed which path it takes.

**Proposed fix.** When stdout is gone, the server has no one to answer, so it exits 0 at once.
- `runMcpServer` listens for `process.stdout`'s `error` event. On EPIPE it calls `process.exit(0)`.
- `send`'s `catch` does the same for an EPIPE thrown synchronously.
- A queued call never runs, because the process is gone. A running daemon op finishes in its daemon,
  as a cancelled call's op does today.

The MCP stdio shutdown text says the client closes stdin first; a client that closes stdin and keeps
reading still gets every answer (measured in S5: exit 0).

**Cost.** Small: `runMcpServer` and `send`. One test that spawns `tests/helpers/mcp-fake-daemon.ts`
with a slow fake `evaluate`, closes the stdout reader, and asserts exit 0 and that the queued call's
handler never ran.
**Value.** No stack trace and no side effects after the client has left.
**Recommendation.** Do.

## F42: MCP arguments of the wrong type are converted or dropped

**Status now.** Still reproduces. `toArgv` (`src/mcp.ts:89-111`) uses the session only when it is a
non-empty string (`:92`), stringifies every other value (`:99`, `:108`), adds a boolean flag only for
`true` or `"true"` (`:106`), and ignores unknown keys. Measured over `bowser mcp`:

```
eval {session: 42, expression: "1"}          -> {"ok":true,"result":1} on session "default", which it spawned
eval {expression: {a:1}}                     -> isError: SyntaxError … ("[object Object]" went to the page)
open {session: "p3f42", persistent: "false"} -> a non-persistent session, no error
open {session: "p3f42b", persistent: 1}      -> the same
eval {expression: "1", bogus: 1}             -> ok; bogus ignored
resize {width: 800, height: 600}             -> ok (numbers stringified; useful)
snapshot {depth: 1}                          -> ok
```

The MCP 2025-11-25 changelog (SEP-1303) says input validation errors are tool results with
`isError: true`, "to enable model self-correction". That is what bowser returns for its other usage
errors.

**Proposed fix.** `toArgv` checks each argument against the tool's own schema and throws
`UserError("usage: …")`, which `prepareToolCall` already turns into an `isError` result:
- `session`, when present, is a non-empty string;
- a positional or string flag is a string, or a finite number (stringified, so `width: 800` keeps
  working);
- a boolean flag is `true` or `false`; `false` adds nothing;
- a key that is not in the tool's `inputSchema` is refused, like an extra CLI argument (F4).

**Cost.** Small: `toArgv`, table tests in `tests/mcp.test.ts`.
**Value.** A wrong session never runs on `default`. A mistyped argument gets a message the model can
fix, instead of a silent wrong action.
**Recommendation.** Do.

### Open decision: numbers where the schema says string

1. **Accept a finite number and stringify it (recommended).** The schema types every positional and
   string flag as `string`, including `width`, `height` and `depth`, but models send numbers there.
   Calls that work today keep working.
2. Strings only, as the schema says. Stricter, but `resize {width: 800}` and `snapshot {depth: 1}`,
   which work today, start failing. Typing those fields `integer` in the schema would fix that, at
   the cost of a numeric kind in the registry.

## #67: a never-settling `eval` before the first page is never freed

**Status now.** Reproduces, now measured. In a session that has loaded no page, `view.url` is `""`, so
`interrupt` (`src/browser.ts:390-411`) takes #48's path: `view.evaluate(LEAVE_INITIAL_DOCUMENT)`. With
the stuck evaluate still pending, WebKit refuses that at once, the `catch` returns, and nothing frees
the view. Measured through the CLI, `BOWSER_OP_TIMEOUT_MS=2000`, `eval "new Promise(r => { window.hold = r })"`
(the promise is kept reachable, as `tests/e2e-hangs.test.ts` does):

| Session | Next `eval location.href` |
| --- | --- |
| committed page (`open <url>`) | fails fast in the queue 3 times, then answers at ~8 s after the timeout |
| fresh (`open`, no URL) | fails fast in the queue every time, still stuck 90 s later; only `close` helps |

Measured on a bare `Bun.WebView` (WebKit, Bun 1.4.2), with that evaluate pending, 300 ms in:

| View | Recovery call | Call result | Stuck evaluate |
| --- | --- | --- | --- |
| fresh (`url ""`) | `reload()` | resolves, url stays `""` | still stuck at 15 s |
| fresh | `evaluate("location.replace('about:blank')")` | throws `an evaluate() is already pending` | still stuck at 15 s |
| fresh | `navigate("about:blank")` | resolves, url `about:blank` | rejects "no longer reachable" at 3.2 s |
| fresh | `navigate("data:text/html,…")` | resolves | rejects at 3.2 s |
| after `navigate("about:blank")` | `reload()` | resolves | rejects at 3.0 s |

In every freed case the next evaluate answered at once.

**Proposed fix.** In `interrupt`'s `view.url === ""` branch, keep #48's `evaluate(LEAVE_INITIAL_DOCUMENT)`
first. When it throws, call `view.navigate("about:blank")`.
- #48's case (a first navigation pending, no evaluate) still takes the first call: `navigate` is refused
  while a navigation is pending (measured in #68).
- #67's case (an evaluate pending, no navigation) takes the second.
- The fresh session loses nothing: it had no page.

The alternative, navigating every new view to about:blank at start so `reload()` always has a page,
also frees the evaluate (last table row). It is not proposed: it costs every session a navigation, and
it changes what `assertNavigated` sees after a first navigation that never commits.

**Cost.** Small: `src/browser.ts`, one unit test in `tests/browser.test.ts` (a fake view whose `url` is
`""` and whose `evaluate` throws while one is pending must receive `navigate("about:blank")`), one e2e
test in `tests/e2e-hangs.test.ts` (fresh session, stuck eval, the next command answers within the
budget plus the grace).
**Value.** Removes the last known way for recovery to leave a session stuck for good.
**Recommendation.** Do.

## Tasks

Three tasks, in this order. Each is one PR, or one commit on this branch.

1. **Recovery and daemon side (#67, F6, F27).** `src/browser.ts` (`interrupt`), `src/daemon/client.ts`
   (debug log file), `src/daemon/server.ts` (`take`), the README row for `BOWSER_DAEMON_DEBUG`. First:
   #67 is the only item that leaves a session stuck for good, and it needs the e2e run.
2. **CLI user errors (F5, F22, F33, F35, F38).** `src/commands/storage-state.ts`,
   `src/commands/interaction.ts`, `src/state.ts`, `src/commands/snapshot.ts`. Unit tests with
   `fakeClient` only. F5's exit code follows the open decision.
3. **MCP protocol (F39, F40, F41, F42).** `src/mcp.ts` only, with `tests/mcp.test.ts`. Last: it is
   independent, and F38's MCP test from Task 2 then passes through the same server.

Skipped: F19 (done in #68), F26 (value below cost).

## Acceptance

- Every new test goes through a public seam: `run()` / `reportFailure`, the `cmd*` functions with
  `fakeClient`, `wrapView` with a fake view, `createHandler` with a fake browser, `createMcpServer` /
  `handleMcpLine`, the spawned `bowser mcp` helper, or the CLI in an e2e test.
- Each fix fails at least one test when it is reverted:
  - F5: drop the checker, and the `state-load` table test for `{"origins":{}}`, `null`,
    `{"cookies":"nope"}` and a `localStorage` object fails;
  - F6: go back to `"inherit"`, and the e2e test that pipes `BOWSER_DAEMON_DEBUG=1 open` and waits for
    EOF within 10 s fails;
  - F22: drop the 16384 check, and the `resize 16385 100` usage test (exit 1, no daemon request) fails;
  - F27: queue the page's object as is, and the `take` test with extra keys fails;
  - F33: read localStorage before the origin check, and the about:blank `state-save` test fails;
  - F35: drop the length check, and the 256-character name test fails;
  - F38: return the bare string again, and the `--json snapshot --filename` test expecting
    `{"ok":true,"filename":…}` fails;
  - F39: echo the requested version again, and the `"1999-bogus"` → `"2025-06-18"` test fails;
  - F40: drop the check, and the array / `123` / `null` → `-32600` tests fail;
  - F41: drop the EPIPE handling, and the spawned-server disconnect test (exit 0, queued call not run)
    fails;
  - F42: accept `session: 42` again, and the test expecting `isError` and no call to `run` fails;
  - #67: drop the `navigate("about:blank")` fallback, and the fake-view test and the fresh-session e2e
    test fail.
- `bun run typecheck`, `bun test` and `BOWSER_E2E=1 bun test` pass.
- README: the `BOWSER_DAEMON_DEBUG` row names the log file; the MCP section lists the supported
  protocol versions. SKILL.md: the `resize` limit.
- CHANGELOG gets a Fixed entry for each done item. F5's entry notes the exit-code change if option 1
  is chosen.
- #67 is closed by the PR.

## Out of scope

- F26's Symbol conversion in the dialog shim.
- A page forging a whole well-formed dialog report (F27's trust limit).
- `localstorage-*` and `sessionstorage-*` on about:blank (F33's FYI).
- `screenshot` failing after `resize 16384 16384` (F22's FYI).
- Other MCP strictness from S5: an unknown tool as `-32602`, object ids, a missing `jsonrpc` field,
  requests before `initialize`, a `method` that is not a string.
- Typing numeric MCP arguments as `integer` in the schema (F42's option 2).
- Navigating every new view to about:blank at start (#67's alternative).
