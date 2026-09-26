# Spec: P1 from the v0.6.0 exploratory testing: input, forms, dialogs, sessions

**Status:** approved 2026-09-27. The owner said "Двигай" (go on) after P0; each open decision below was ruled option 1, and the other options stay for the record.
**Origin:** the P1 tier of the findings page from the v0.6.0 exploratory testing. The repros come from
the session sheets `S1.md`–`S5.md` of that run. They are restated below so this spec stands alone.

Every finding was rechecked on `main` at `d3ed815` (after P0, #46): a binary compiled from
`src/cli.ts`, `HOME` set to a temporary directory, and local pages served by `Bun.serve` on
127.0.0.1. The reference is `playwright-cli` 0.1.13 with `--browser=webkit`. All 12 findings still
reproduce. F15's wedge is only partly fixed by P0 (see F15).

## Task 1: Input

### F4: extra positional arguments are silently dropped

**Measured.**
- `eval 1 + 1` prints `1`. `goto <url> extra` navigates. `localstorage-set a b c` sets `a`.
  `snapshot e1` prints the whole page. All exit 0. On v0.6.0, `fill e4 hello world` filled `hello`
  and `type foo bar` typed `foo`.
- Still reproduces on main: yes (`eval 1 + 1` → `1`, `goto <url> extra`, `localstorage-set a b c`,
  `snapshot e1`, all exit 0).
- Cause: `parse` pushes every word after the command into `positional` with no limit
  (`src/cli/parser.ts:124`). `run` passes them all on (`src/cli.ts:19`), and each command reads only the
  indexes it knows (for example `src/commands/scripting.ts:36`). The `mcp` branch of the entry
  (`src/cli.ts:52`) ignores any word after `mcp`, so `bowser mcp extra` starts the server.
- playwright-cli: `eval 1 + 1` fails with `error: too many arguments: expected 2, received 3` and the
  command's help, exit 1. `goto <url> extra` gives `expected 1, received 2`.

**Behaviour.**
1. A command given more positionals than its registry entry declares fails before it connects to a
   daemon: `usage: too many arguments for '<cmd>': expected <n>, received <m>`. It exits 1.
2. The count comes from the registry (`Command.positional`), so a new command gets the check for free.
3. After `--`, words still count as positionals: `fill e1 -- a b` is too many.
4. `bowser mcp` with any positional fails the same way and does not start the server.
5. MCP tool calls are unaffected: `toArgv` builds argv from the schema, so it never passes extras.

### F15: a URL without a scheme is not normalized

**Measured.**
- `open example.com` fails with `The URL can’t be shown`, exit 2. `goto 127.0.0.1:<port>/two` fails
  the same way.
- `goto localhost:<port>/two` times out (`operation 'navigate' timed out`). WebKit reads `localhost:`
  as a URL scheme.
- Still reproduces on main: yes. The wedge is partly fixed by P0:
  - From a real page, with `BOWSER_OP_TIMEOUT_MS=3000`, the next `eval location.href` answers the old
    URL, so the recovery reload freed the session.
  - From a fresh session on `about:blank`, it did not. `goto localhost:<port>/two` timed out. Then
    `eval location.href` (twice, 5 s apart) and `goto http://127.0.0.1:<port>/two` each failed after
    3 s with `waiting for 'navigate', which timed out and is still running`. Only `close` helped. With
    the default 30 s budget, the same sequence also left the session stuck.
- Cause: `cmdOpen` and `cmdGoto` pass the URL as typed (`src/commands/navigation.ts:50`, `:66`), and
  `wrapView` hands it to `view.navigate` (`src/browser.ts:275`).
- playwright-cli: `goto example.com` goes to `https://example.com/`. `goto localhost:<port>/` goes to
  `http://localhost:<port>/`. `goto 127.0.0.1:<port>/two` and `open 127.0.0.1:<port>/two` go to
  `https://127.0.0.1:<port>/two` and fail with a TLS error. Its rule (`checkUrlAndNavigate`, then
  `completeUserURL` in playwright-core): a string `new URL()` rejects gets `http://` if it starts with
  `localhost` and `https://` otherwise; a parsed URL that starts with `localhost` or `127.0.0.1` gets
  `http://`.

**Behaviour.**
1. `open` and `goto` add a scheme to a URL that has none, before the daemon sees it. A URL has none
   when `new URL()` rejects it, or when it starts with `host:port` (`localhost:3000/x`,
   `example.com:8080`).
2. The scheme is `http://` for `localhost`, `127.0.0.1` and `[::1]`, and `https://` for any other host.
   This differs from playwright-cli for `127.0.0.1`, where playwright-cli picks `https://` and then
   fails. It is a deliberate difference, and it only turns a failure into a success.
3. A URL with a scheme (`http:`, `https:`, `file:`, `about:`, `data:`, and any other) is passed through
   unchanged.
4. The reply shows the normalized URL, as it already shows the final URL.

## Task 2: Forms

### F12: `select` by label, or with a missing value, clears the select and reports success

**Measured.**
- On `<select id=color><option value="r">Red</option><option value="g">Green</option></select>`:
  - `select e3 g` works: `color.value` is `g`.
  - `select e3 Red` prints `selected e3 -> "Red"`, exit 0, and leaves `color.value` empty with
    `selectedIndex` -1.
  - `select e3 nosuch` does the same.
- Still reproduces on main: yes.
- Cause: `selectScript` assigns `el.value = value` and fires `input` and `change`
  (`src/page-scripts.ts:671-679`). An assignment that matches no option deselects everything.
  `cmdSelect` reports success unconditionally (`src/commands/interaction.ts:121-129`).
- playwright-cli: `select e3 Red` selects `r`. `select e3 nosuch` fails with `TimeoutError: Timeout
  5000ms exceeded` after 5 s, and the value is unchanged.

**Behaviour.**
1. `select` picks the first option, in document order, whose value or label equals the text. This is
   playwright's `selectOption` rule.
2. When no option matches, `select` fails at once, without waiting: `ref 'eN' has no option "<text>"`.
   The select keeps its value, and no `input` or `change` event fires. It exits 1, and the `cli.ts`
   exit-code regex is updated to match.
3. The success reply is unchanged.

### F13: `fill` on a disabled or readonly input clears it and reports success

**Measured.**
- `<input id=ro readonly value="ro">` and `<input id=dis disabled value="dis">`: `fill e5 x` and
  `fill e7 x` print `filled …`, exit 0, and both values become `""`.
- Still reproduces on main: yes.
- Cause: `cmdFill` clicks, clears, then types (`src/commands/interaction.ts:87-93`).
  `clearForFillScript` sets `value = ''` without checking the element (`src/page-scripts.ts:692-698`).
  The native type then does nothing, silently.
- playwright-cli: both fail with `TimeoutError: Timeout 5000ms exceeded` after 5 s (it waits for the
  element to be editable). The values stay `ro` and `dis`.

**Behaviour.**
1. `fill` on an element that is disabled (`:disabled`, which includes a disabled `<fieldset>`) or
   read-only (`readOnly`) fails at once: `ref 'eN' is not an editable element (disabled)` or
   `(readonly)`. It exits 1 through the existing `is not an?` pattern.
2. The value is unchanged, and no `input` event fires.
3. No extra daemon round trip: the check runs inside a page script `fill` already sends.

### F14: `fill` on `type=date` or `type=number` with text does nothing and reports success

**Measured.**
- `fill e9 2024-01-02` on `<input type=date>` prints `filled e9 (textbox "Date")`, exit 0, and
  `d.value` stays `""`. S2 found the same with `click` then `type`.
- `fill e11 abc` on `<input type=number>` prints `filled`, and the value stays `""`. `fill e11 42`
  works.
- Still reproduces on main: yes.
- Cause: `fill` enters text through WebKit's native `type` (`src/commands/interaction.ts:91`). It
  types nothing into a date input, and a number input drops text that is not a number.
- playwright-cli: the date fills (`2024-01-02`). `fill e11 abc` fails with `Error: Cannot type text
  into input[type=number]`. playwright sets the value of `date`, `time`, `datetime-local`, `month`,
  `week`, `color` and `range` inputs directly. It fails with `Malformed value` when the value does not
  stick.

**Behaviour.**
1. On an `<input>` of type `date`, `time`, `datetime-local`, `month`, `week` or `color`, `fill` sets the
   value in the page and fires `input` and `change`, as playwright does. No native typing.
2. When the page does not keep the value (for example `fill e9 tomorrow` on a date), `fill` fails with
   `ref 'eN' did not accept the value for input[type=<type>]`, exit 1. The value is unchanged.
3. On `type=number`, a text that `Number()` reads as `NaN` fails with `ref 'eN' needs a number
   (input[type=number])`, exit 1. The value is unchanged.
4. No error message contains the entered text. This is the no-echo rule (`withholdingText`).
5. No extra daemon round trip.

## Task 3: Dialogs

### F23: a dialog that fires between commands is lost if the next command navigates

**Measured.**
- Repro:
  ```sh
  bowser -s=r1 open http://127.0.0.1:<port>/
  bowser -s=r1 eval "(setTimeout(()=>{window.fired=confirm('timer')},200),1)"
  sleep 1
  bowser -s=r1 reload          # or goto <url>, open <url>, go-back
  bowser -s=r1 snapshot        # no ### Modal state
  ```
  With `snapshot` in place of `reload`, it prints `- ["confirm" dialog with message "timer"]:
  dismissed (run dialog-accept before the action to accept it)`.
- On main, `press Enter` loses it too. The input is focused in a form whose action is `/two`, a
  timer confirm fires, then `press Enter` submits. It prints `pressed Enter`, and no report ever
  appears. S3 suspected this and did not test it.
- S3 also saw a stale report come back on `go-back` when the old page returned from the back-forward
  cache. It was attributed to the wrong command.
- Still reproduces on main: yes (`reload`, `goto`, `open`, `go-back` and `press Enter`).
- Cause: `runShimmed` (`src/daemon/server.ts:291-299`) reads the page's log before an op only when the
  page has no shim yet (`ACTS.has(req.op) && !shimmed`, line 296). A navigating op sets
  `shimmed = false` first (line 295), so it never reads the log. The log leaves with the document.
  `click` escapes only because its ref lookup is an `evaluate` that reads the log.
- playwright-cli: a dialog stays open until answered and shows in the next command's modal state.
  It is never lost.

**Behaviour.**
1. Before an acting op (`ACTS`) or a navigating op (`NAVIGATES`) runs on a document that has the
   shim, the daemon reads the shim's log. The dialogs are reported by that command.
2. The read happens inside the daemon: one page evaluate, no extra socket round trip. A page that
   cannot evaluate reports nothing, as `sync` already does.
3. After a back-forward cache restore, no report that was already read comes back.

### F24: the shim overwrites the page's own `window.confirm` and `alert`

**Measured.**
- Repro page:
  ```html
  <script>window.confirm = m => { out.textContent = 'custom:' + m; return true }</script>
  <p id=out>none</p><button onclick="var r=confirm('really'); out.textContent += ' r='+r">C</button>
  ```
  `click e3` reports `["confirm" dialog with message "really"]: dismissed …`, and the page shows
  `none r=false`. The page's function never ran.
- Still reproduces on main: yes.
- Cause: `dialogShim` assigns `window.alert`, `confirm` and `prompt` unconditionally when its symbol is
  missing (`src/page-scripts.ts:584-586`).
- playwright-cli: the page's function runs (`custom:really r=true`), and there is no modal state.

**Decision: how to respect a page-defined `alert`/`confirm`/`prompt`.** Ruled: option 1.
1. **(Recommended) Replace only a native function.** When the shim installs, it leaves alone any of
   the three that is no longer the browser's own (its `Function.prototype.toString` lacks
   `[native code]`). The page's function runs, as in playwright-cli. Cost: a page wrapper that calls
   the native function it saved (`const orig = confirm; window.confirm = m => orig(m)`) hits the
   engine directly. That dialog is then dismissed and not reported. This is the documented
   saved-reference limit, so README and SKILL.md name it.
2. **Wrap.** The shim calls the page's function when there is one, and reports nothing. The result is
   the same as option 1, with more code in the shim.
3. **Keep overwriting, and document it.** No code change. Pages with in-page modals and test stubs
   keep behaving differently under bowser.

### F25: an iframe dialog is dismissed and not reported, and the prepared answer carries over

**Measured.**
- Repro: a page with `<iframe src="/inner">` (same origin), a button that runs
  `out.textContent='viaframe:'+frames[0].confirm('frame')`, and a button that runs
  `out.textContent='top:'+confirm('top')`.
  ```sh
  bowser dialog-accept
  bowser click e3     # ViaFrame: no ### Modal state; the page shows viaframe:false
  bowser click e4     # Top: ["confirm" dialog with message "top"]: accepted   <- the leftover answer
  ```
  S3 saw the same with a button inside the iframe, and on w3schools Tryit (`tryjs_confirm`).
- Still reproduces on main: yes.
- Cause: the shim is installed in the top window only (`dialogShim`, `src/page-scripts.ts:560-594`).
  A frame's dialog goes to the engine, which dismisses it. The one-shot answer is cleared only when a
  top-level dialog uses it or on `pagehide` (lines 569-570, 589), so it waits for the next top-level
  dialog.
- playwright-cli: reports `["confirm" dialog with message "frame confirm from top"]`, and
  `dialog-accept` makes it return `true`.
- Docs: README and SKILL.md list three unreported cases. Iframes are not among them.

**Decision: iframe dialogs.** Ruled: option 1.
1. **(Recommended) Shim same-origin frames too.** Each sync also installs the shim in every
   same-origin child frame it can reach from `window.frames`, and reads their logs. Frame shims use
   the top window's one-shot answer. Cost: a frame walk in each sync. A frame that loads after
   bowser's last op has no shim until the next op, the same limit as a top-level document. A
   cross-origin frame cannot be reached from the top document. Its dialogs stay unreported, and a
   prepared answer still carries over past them. Docs name that limit.
2. **Document only.** Add iframes to the unreported cases in README and SKILL.md, and say that a
   prepared answer stays set. Cost: the carry-over stays. An answer meant for a frame dialog is spent
   on a later top-level dialog.
3. **Document and drop the answer after each action.** Clear the one-shot answer after the op that
   followed `dialog-accept`, so it cannot carry over. Cost: it breaks a dialog that a click's handler
   opens after a delay, which works today.

## Task 4: Sessions

### F28: after a crash, a `--persistent` session silently comes back in memory

**Measured.**
- Repro:
  ```sh
  bowser -s=p28 open http://127.0.0.1:<port>/ --persistent
  bowser -s=p28 eval "localStorage.setItem('pre','1'), 1"
  kill -9 $(cat ~/.bowser/sessions/p28/pid)      # pid, sock and state.json stay behind
  bowser -s=p28 goto http://127.0.0.1:<port>/two # exit 0: a new in-memory daemon
  bowser -s=p28 eval "localStorage.getItem('pre')"            # empty
  bowser -s=p28 eval "localStorage.setItem('post','1'), 1"
  bowser -s=p28 open http://127.0.0.1:<port>/ --persistent    # usage: … already open with a different profile (exit 1)
  bowser -s=p28 close; bowser -s=p28 open http://127.0.0.1:<port>/ --persistent
  bowser -s=p28 eval "localStorage.getItem('pre') + ' ' + localStorage.getItem('post')"   # 1 null
  ```
  Everything done after the crash is lost.
- Still reproduces on main: yes.
- Cause: `connectOrSpawn` spawns a daemon whenever it cannot connect (`src/daemon/client.ts:164-180`).
  Only `open` passes a profile (`src/commands/navigation.ts:59`), so any other command respawns in
  memory. Nothing records that the dead session was persistent, and nothing tells the caller that
  the browser was replaced.
- playwright-cli: after a kill, `Browser 's4pw' is not open. Run playwright-cli -s=s4pw open`. For a
  session that was never opened, every command but `open` says `The browser '<name>' is not open,
  please run open first`, exit 1. bowser instead documents lazy spawn: "spawned lazily on first
  command" (README), and "the first tool call on a fresh session spawns one" (README, MCP).

**Decision: what a command does when the session's browser has died.** Ruled: option 1.
1. **(Recommended) Refuse after a crash, keep lazy spawn for a fresh session.** When the session
   directory holds `state.json` (a daemon ran there) and no daemon answers, every command except
   `open` and `close` fails with `session '<name>' is not open (its browser exited); run 'bowser open'`,
   exit 1. A fresh session still spawns on its first command. Cost: the session directories that
   earlier versions left behind also refuse until `open` or `close`, and the message must be
   documented.
2. **Respawn with the recorded profile.** `open` records the profile in the session directory, and
   any respawn uses it, with one stderr line saying the browser restarted. Cost: the page, refs and
   session cookies are still gone, and the agent learns that only from stderr.
3. **Full playwright-cli parity: only `open` starts a browser.** Cost: it breaks the documented lazy
   spawn for the CLI and MCP (`dialog-accept` before `open`, a first `goto` on a fresh session), and
   the docs and tests that rely on it.

### F29: concurrent first commands spawn several daemons for one session

**Measured.**
- Repro:
  ```sh
  for i in 1 2 3 4 5; do ( bowser -s=r5x open "http://127.0.0.1:<port>/?i=$i" >/dev/null 2>&1 ) & done; wait
  pgrep -f -- "--daemon r5x$" | wc -l     # more than 1
  bowser -s=r5x close
  pgrep -f -- "--daemon r5x$" | wc -l     # orphans left
  ```
- Still reproduces on main: yes, 3 of 3 trials. There were 2, 3 and 3 daemons before `close` and 1,
  2 and 2 after it. In one trial the pidfile was missing. That is F30, the loser deleting the
  winner's pidfile.
- Cause:
  - The client spawns with no lock (`src/daemon/client.ts:180`).
  - Each daemon unlinks the socket unconditionally (`src/daemon/server.ts:333-336`), even one a live
    daemon is listening on. That daemon becomes unreachable, and `close` and `list` never see it.
  - Each daemon overwrites the pidfile (line 343). A daemon that then fails to listen removes the
    pidfile it wrote last (`removePidFileIfOwned`, lines 45-49, 344-346).
- A second trigger has the same result (S4): delete a live daemon's `sock`, then run any command.
- playwright-cli: not compared. It does not spawn on a first command (see F28).

**Decision: the lock.** Ruled: option 1.
1. **(Recommended) The daemon claims the session before anything else.** `startDaemon` creates the
   pidfile exclusively (`O_EXCL`). If it exists and names a live daemon of ours (`looksLikeOurDaemon`),
   the newcomer exits without touching the socket or the pidfile, and the racing clients connect to
   the winner as they already poll. A pidfile naming a dead or foreign pid is stale: remove it and
   claim once more. The socket is unlinked only after the claim. This also fixes F30. Cost: the
   stale-claim path must itself be race-safe, and the second trigger (a deleted `sock`) then fails
   with "did not start in time" instead of starting a second daemon.
2. **A client-side spawn lock.** `connectOrSpawn` takes an exclusive lock file in the session
   directory around spawn-and-wait. The other clients wait on the socket. Cost: a CLI killed while
   holding the lock leaves it stale, so it needs a pid and an age check. The daemon still unlinks a
   live socket, so the deleted-`sock` trigger stays.
3. **Listen first, probe on conflict.** The daemon never unlinks blindly. On `EADDRINUSE` it pings the
   socket, exits if a daemon answers, and unlinks and retries only if none does. No lock file. Cost:
   two daemons that both find a stale socket can still race, in a narrower window.

### F31: `close --all` exits 0 when a session failed to close

**Measured.**
- Repro:
  ```sh
  bowser -s=ok31 open http://127.0.0.1:<port>/
  mkdir -p ~/.bowser/sessions/stale31 && echo 1 > ~/.bowser/sessions/stale31/pid
  bowser close --all          # closed 1 session: ok31; failed: stale31     exit 0
  bowser --json close --all   # {"ok":false,"closed":[],"failed":["stale31"]}  exit 0
  bowser -s=stale31 close     # close: pid 1 recorded for session 'stale31' is running but does not look like a bowser daemon; … exit 2
  ```
- Still reproduces on main: yes.
- Cause: `closeAll` catches each failure, keeps only the name, and returns a string
  (`src/commands/navigation.ts:286-302`). The CLI exits 0 for any returned string (`src/cli.ts:63-64`).

**Behaviour.**
1. `close --all` still tries every session.
2. If any session failed, it exits 2. That is the exit code a single `close` gives for the same cause.
3. Each failed session is named with its reason, which is the message `close` would print for it.
4. The sessions it did close are still listed. Under `--json`, the failure follows the error
   convention, like every other error (plain text on stderr).
5. With no failures, the output and exit code are unchanged.

### F37: MCP writes file outputs relative to the server's cwd

**Measured.**
- Repro: start `bowser mcp` from `/` with `HOME` set, then call `open`, then:
  - `screenshot {session}` → `isError`: `EROFS: read-only file system, open '/screenshot-m37.png'`;
  - `snapshot {session, filename: "snap.txt"}` → `EROFS … open 'snap.txt'`;
  - `state-save {session, file: "st.json"}` → `EROFS … open '/st.json'`.
- From a writable cwd, `screenshot` answers `{"ok":true,"filename":"screenshot-<session>.png"}`. That
  path is relative to a directory the client does not know.
- Still reproduces on main: yes (all three).
- Cause: the MCP server calls `run` in its own process, so every path resolves against its cwd:
  - `snapshot --filename` writes the name as given (`src/commands/snapshot.ts:31-34`);
  - `screenshot` resolves against `process.cwd()` and replies with the relative name (lines 68-77);
  - `state-save` and `state-load` use `resolve(file)` (`src/commands/storage-state.ts:46`, `:70`).
  - `runMcpServer` never changes its cwd (`src/mcp.ts:312`).
- Precedent: Playwright MCP resolves output files against an output directory. That directory is
  the cwd, or `os.tmpdir()/.playwright-mcp` when the cwd is `/` or not writable (`outputDir` in
  playwright-core).

**Behaviour.**
1. At start, when its cwd is `/` or not writable, `bowser mcp` creates `<os.tmpdir()>/bowser-mcp` and
   makes it its cwd. Relative paths from tool calls then resolve there. A writable cwd is kept.
2. `screenshot`, `snapshot --filename` and `state-save` report the absolute path they wrote, on the
   CLI and over MCP. `state-save` and `state-load` already do.
3. An absolute path from the client is used as given.

## Acceptance (public seams only)

1. **Unit tests** cover:
   - F4: for every registered command, one positional over its declared count fails with `usage:`,
     makes no daemon request, and exits 1 through `reportFailure`. `mcp extra` does not start the
     server (spawned entry, as the F1 help test does);
   - F15: the normalization table, from `open`/`goto` through a fake client that records the URL:
     `example.com` → `https://example.com`, `localhost:3000/x` and `127.0.0.1:3000` → `http://…`,
     `http://…`, `about:blank`, `data:…` and `file:///…` unchanged;
   - F31: `closeAll` with one session that fails, through injected process ops: exit 2, every session
     tried, the reason printed;
   - F37: the MCP server started with an unwritable cwd writes a default `screenshot` under
     `os.tmpdir()/bowser-mcp` and replies with an absolute path;
   - F23: through `createHandler` with a fake browser, a log entry present before a `reload`,
     `navigate`, `back` or `press` is reported by that op;
   - F29 (per the decision): two daemons starting on one session leave one listening daemon and its
     pidfile.
2. **WebKit e2e** covers:
   - F12: select by label, and a missing option (exit 1, value unchanged);
   - F13: fill on readonly and disabled inputs (exit 1, value unchanged);
   - F14: fill on `type=date` sets the value; text on `type=number` fails, value unchanged;
   - F23: a timer confirm, then `reload`, then the report on `reload`'s output; the same with
     `press Enter` submitting a form;
   - F24 and F25 per the decisions: a page-defined `confirm` runs; a same-origin iframe confirm is
     reported and takes the prepared answer;
   - F28 per the decision: `kill -9` of a persistent session's daemon, then the next command's result;
   - F29: five concurrent `open`s on a new session leave exactly one daemon, and none after `close`.
3. **Mutation checks:** every fix, when removed, fails at least one test.
4. **Docs:**
   - README and SKILL.md: `select` matches value or label; `fill` refuses disabled and readonly inputs
     and sets date-like inputs; URLs without a scheme; the dialog limits as decided (F24, F25); what a
     command does after a crash (F28); where MCP writes relative paths;
   - CLAUDE.md: the new user-error messages next to the exit-code regex, and the spawn claim (F29) in
     the gotchas;
   - CHANGELOG Unreleased.

## Out of scope

- F15's other half: a stuck navigation from `about:blank` that the P0 recovery reload does not free
  (measured above). Normalization removes this trigger. The recovery gap itself belongs to a P0
  follow-up.
- Everything next to these findings that the sheets list separately:
  - F20 (`check` on a disabled checkbox, `uncheck` on a radio, `click` on a disabled button);
  - F30 (the pidfile, beyond what the F29 decision fixes);
  - F42 (MCP arguments of the wrong type, and unknown keys);
  - F38 (`snapshot --filename` answering plain text under `--json`).
- Multi-select `select` with several values. playwright-cli's `eval <func> [target]` second
  positional.
- Returning a screenshot as MCP `image` content. A `--output-dir` flag or env var for MCP.
- Cross-origin iframe dialogs, `beforeunload`, and page-forged dialog reports.
