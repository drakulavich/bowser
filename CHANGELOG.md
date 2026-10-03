# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Ref commands name their element under `--json` and over MCP.** `click`, `fill`, `hover`,
  `select`, `check` and `uncheck` add `"element":{"role":"…","name":"…"}`, the role and name the
  snapshot gave the ref. An MCP agent got only `{"ok":true,"ref":"e724","url":…}` and could not
  tell which of several "Add to cart" buttons it had clicked; the plain output already printed
  `clicked e724 (button "Add to cart")`. `fill` still never returns the entered text. (#117)

### Fixed

- **`reload` fails when the page does not load.** With the page's server down, `reload` answered
  `reloaded <url>`, exit code 0, while WebKit had failed to load the page. It now fails the way
  `goto` does: `bowser: Could not connect to the server.`, exit code 2. A reload that a page script
  cancels still waits for the script's navigation. (#123)
- **A timeout says when the action may already have reached the page.** With
  `BOWSER_OP_TIMEOUT_MS=50`, `click` on an "Add to cart" button answered `'click' timed out after
  50ms`, exit code 2, although the cart count went up, so an agent that retried added the item
  twice. A timeout that hits once the action was sent now says `'click' timed out after <ms>ms; the
  click may have been delivered, check the page before retrying`, and `… the click was delivered,
  check the page before retrying` once the action returned. In a step of another command it reads
  `'fill' timed out after <ms>ms (in its 'click' step); the click may have been delivered but the
  fill did not finish, check the page before retrying`. This covers `click`, `fill`, `type`,
  `press`, `hover`, `select`, `check` and `uncheck`. A timeout before the action was sent keeps the
  plain message. A `click` still waiting for a target that another element covers says "may have
  been delivered" too: bowser cannot tell that wait from a click WebKit already fired. A click that returned but opened no page no longer says `waiting for the page it
  opened`, and the recovery no longer reloads its page while bowser is still checking whether the
  click started a navigation. (#115)
- **A `click` on a covered target no longer answers with Bun's own timeout text.** Bun's click
  deadline falls 50 ms after bowser's reply timer, so when the timer was late, `click` or `fill`
  answered `timeout waiting for 'main > button:nth-child(2)' to be actionable`. It now gets the
  same message the timer gives: `'click' timed out after <ms>ms; the click may have been
  delivered, check the page before retrying`, or the `fill` form of it. (#122)
- **A ref acts only on the page whose snapshot gave it.** After `go-back` restored a page from the
  back-forward cache, a ref from the page just left clicked the restored page's element with the
  same ref, role and name, exit code 0. After a click left a slow navigation pending, the next ref
  command found its element on the old page and clicked the same spot on the new one. A snapshot
  now saves the page's id with its refs, a ref command waits for a pending navigation before it
  looks the ref up, and a ref from another page fails with `ref 'eN' is from a page that is no
  longer loaded; take a new snapshot`, exit code 1. That message replaces `not found` for a ref
  from before a navigation or reload; `pushState` and `#hash` changes keep the refs. (#105)
- **`reload` returns once the reloaded page has loaded.** On a page whose server was slow to
  answer, `reload` replied `reloaded <url>` after 0.1 s while the old document was still live. A
  `goto` right after it failed with WebKit's `The operation couldn’t be completed.
  (NSURLErrorDomain error -999.)`, exit code 2, and a ref from before the reload answered `not
  found` instead of `is from a page that is no longer loaded`. `reload` now waits for its page the
  way `goto` does, within the command's budget, and a timeout says `'reload' timed out after
  <ms>ms waiting for the page it opened; the reload was delivered, check the page before
  retrying`. (#116)
- **`goto` and `open <url>` land when they cancel a navigation still loading.** When a page script
  or a reload had started a navigation that was still loading, `goto` failed with the same
  `NSURLErrorDomain error -999` text although its own page went on to load. It now waits for that
  page. If something else cancels the `goto` itself, it fails with `navigate: the navigation to
  <url> was cancelled by another navigation; run 'bowser snapshot' to see where the page is`.
  (#116)
- **`click` and `fill` refuse a ref another element covers.** Under a full-page backdrop, `click`
  waited until its budget ran out (exit 2), and with a short budget it left the session stuck.
  On a button the page had just swapped for a `- qty +` stepper, a second `click` pressed `+` and
  reported the original button. The lookup now checks what is at the element's centre after
  scrolling it into view, and fails at once, exit code 1, naming what is there: `ref 'eN' (button
  "Add to cart") is covered by generic <div> at its click point; take a new snapshot or close what
  covers it`. A cover that appears after that check now fails the click at the command's budget,
  and the session stays usable. (#112)

## [0.10.1] — 2026-09-30

### Fixed

- **An action waits for a navigation a script started in place of a pending one.** After a
  submit to a server that had not answered within the 10 s watch, a page script that navigated
  elsewhere cancelled the first navigation, and that cancellation counted as the end of the load.
  The next `fill` or `click` then went into a page still loading and hung until its budget. The
  navigation now stays pending while the page is asked whether it started another, and the next
  action waits for that one, or fails with `page is still loading <url>`. (#98)
- **A persistent session whose browser exited is told to reopen it with `--persistent`.** The
  refusal said `run 'bowser open'`, and doing just that started an empty in-memory browser, so
  the session looked logged out although its profile was intact on disk. When the session has a
  profile, the refusal now says `run 'bowser open --persistent'`. (#79)
- **The upgrade refusal keeps `--persistent` too.** "run 'bowser close -s <name>', then open it
  again" led a persistent session to the same empty browser. For a session with a profile it now
  says "then open it again with 'bowser open --persistent'". (#79)
- **A `bowser mcp` server that outlived an upgrade says to restart it.** It starts new daemons
  from the upgraded files, then refused each one as a daemon of another version, and "close, then
  open it again" only repeated the refusal. When the refused daemon matches the installed version,
  it now says "this bowser (<w>) differs from the installed bowser (<v>); restart the MCP server
  or re-run the command". (#79)
- **An action on a ref whose element changed its name is refused.** A `Buy A` button that
  relabelled itself `Delete account` kept its ref, and a second `click e2` without a new snapshot
  pressed `Delete account` and replied `clicked e2 (button "Buy A")`, exit code 0. Every ref
  command now compares the element's current role and accessible name with the snapshot's, in the
  same page request that finds the element, and on a difference fails with exit code 1 before it
  touches the page: `ref 'e2' now points to button "Delete account", not button "Buy A"; take a
  new snapshot`. (#80)
- **A `playwright-cli` frame ref is named as such.** `fill f1e3 …` answered `expected a ref like
  'e1', got 'f1e3'. Run 'bowser snapshot' first.`, but no snapshot prints such a ref. It now says
  `'f1e3' is a playwright-cli frame ref; bowser does not snapshot iframe contents`. (#80)
- **CI runs every e2e test file.** The workflow listed the files by hand and had missed five of
  them: `e2e-session-gate`, `e2e-known-state`, `e2e-patched-builtins`, `e2e-search` and
  `e2e-utf8`. It now runs `bun test tests/e2e`, which picks up every `tests/e2e*.test.ts`.
- **The advice to reopen a session names the profile it really had.** Both refusals from #79
  guessed from whether `~/.bowser/profiles/<name>` existed. A session opened with
  `--profile=<dir>` was told `bowser open` and came back without its data, and an in-memory
  session was told `--persistent` whenever an earlier session had left that directory behind.
  `open` now records the session's profile in its state, and the advice follows the record:
  `bowser open --persistent`, `bowser open --profile=<dir>` or `bowser open`. A session opened by
  an older bowser has no record and still gets the directory check. (#93)
- **A `fill` that timed out waiting for the page its click opened no longer claims the fill was
  delivered.** Only the click reached the page. The message now says `'fill' timed out after
  <ms>ms waiting for the page its click opened; the click was delivered but the fill did not
  finish, check the page before retrying`. A plain `click` keeps its message. (#78)
- **The restart advice no longer calls a downgraded process older.** The message said "this bowser
  (<w>) is older than the installed bowser (<v>)" whenever the two versions differed, so after a
  downgrade it had the direction wrong. It now says "differs from". (#79)

## [0.10.0] — 2026-09-30

### Fixed

- **Parallel commands on one session no longer mix their steps.** A command sends the daemon
  several requests, and the daemon kept only the requests in order, so another client's command
  could run between them. Three parallel `fill`s all reported success while their text landed in
  one field, and the next `snapshot` could print the password. A `click` raced against a
  `goto` reported the button it resolved on page one and clicked the button at the same place on
  page two. Parallel `open`s all printed the URL that loaded last. The daemon now runs one
  client's command at a time on a session, and the other clients wait their turn. A request that
  runs out of time while waiting fails with "(waiting for another client's command on this
  session)", exit code 2. A client that crashes frees the session at once, and one that stops
  responding frees it after `BOWSER_OP_TIMEOUT_MS`. `close` still works at any time. (#77)
- **`screenshot` of a viewport too large to capture says what to do.** After
  `resize 16384 16384` on a Retina display, `screenshot` failed with "An unknown error occurred"
  and exit code 2. WebKit refuses a capture whose pixels fill 4 GiB (32768x32768 pixels at pixel
  ratio 2), and `Bun.WebView` has no option to capture at a lower scale. `screenshot` now fails
  with exit code 1 and names the size that fits: `run 'bowser resize 16384 16383' or smaller`.
  `resize`'s limits are unchanged: every size it accepts works for everything but a screenshot,
  and at pixel ratio 1 no size it accepts should reach the limit (by the same arithmetic; not
  measured). (#69)
- **Long non-ASCII text crosses the daemon socket intact.** A message over the socket's ~8 KB read
  size could arrive with a multi-byte character split between two reads, and each read was decoded
  on its own, so that character became U+FFFD, reported as success. It hit both directions: a long
  `eval` result or `snapshot` came back with `�`, and a long `fill` put `�` into the page.
  `eval "'é😀'.repeat(2000)"` printed three of them. Both ends of the socket now decode it as one
  stream per connection. (#75)
- **Pages that patch `toJSON` no longer garble what bowser reads from them.** `Bun.WebView` sends
  a page's answer through the page's own `JSON`, so a page that set `Array.prototype.toJSON`, as
  Prototype.js does, rewrote every array in it: `snapshot` printed `- text: p` … `- text: o`,
  `eval "['x','y']"` printed `proto`, and `fill`/`click` failed with
  `state.refs.find is not a function`. A page-wide `Object.prototype.toJSON` emptied `eval`
  results and broke `snapshot`. bowser now serializes its answer in the page with those two set
  aside for that one call, then puts them back. What `eval` returns: the value your expression
  produced, as `JSON.stringify` would give it on a page without those two patches. A value's own
  `toJSON`, a class's (`Date`, `URL`), and anything your expression itself calls, such as
  `JSON.stringify(['x'])`, still see the page as it is. (#76)
- After a timed-out `click` whose page never answered, the next command could run before the
  recovery reload landed. It reported the old page as success, failed with an unrelated error, or
  wedged the session until `close`. Recovery now holds the session until its own reload lands. (#78)
- A command that outlives the recovery reload, such as an `eval` of a promise the page keeps,
  no longer makes every later command wait out its whole budget. Every command but `close` now
  fails at once with `session is stuck: '<cmd>' is still running after a reload; run 'bowser close'`,
  exit code 2, until that command ends. (#78)
- After a form posted to a server that never answers, the next `fill` hung for its whole budget
  and never typed. An action now waits for a navigation an earlier command left pending, and fails
  with `page is still loading <url>; retry later, or run 'bowser close'`, exit code 2, if it is
  still pending when the time runs out. (#78)
- A timeout while an action waits for the page it opened now says the action reached the page:
  `'click' timed out after 3000ms waiting for the page it opened; the click was delivered, check
  the page before retrying`. It used to read as a failed click, so a retry could click twice. (#78)

### Changed

- `BOWSER_OP_TIMEOUT_MS` is a budget for the whole command. Each step used to get the full
  budget, so `fill` with a 3 s budget answered after 5 s. Each step now gets what its command has
  left. A value set on a later command applies to that command when it is smaller than the
  session's, and a timeout names it. (#78)

## [0.9.0] — 2026-09-28

### Changed

- **Every `state-load` file error exits 1.** A missing file and invalid JSON exited 2, as a
  runtime error; they are the user's input to fix, like a bad flag, so they now exit 1, as does
  the new shape check. (F5)

### Fixed

- **A missing required argument is a usage error for every command.** `bowser select e3` and
  `bowser localstorage-set k` used to run with an empty value, because the missing word reached
  the command as `""`. They now fail before connecting, with the command's usage line
  (`usage: bowser select <ref> <value>`) and exit code 1, like `playwright-cli`. An explicitly
  empty argument (`select e3 ""`, `fill e2 ""`, `localstorage-set k ""`) still runs, as it does
  in `playwright-cli`. (#60)
- **`press` takes key combinations, as `playwright-cli` does.** `bowser press Shift+Tab` used to
  fail with "must be a virtual key name". `press` now takes `Modifier+…+Key` with `Shift`,
  `Control`, `Alt`, `Meta` and `ControlOrMeta` (`Meta` on macOS). Measured on WebKit: `Shift+Tab`
  moves focus back, `Meta+a` selects all, `Meta+z`/`Shift+Meta+z` undo and redo, `Control+a` and
  `Meta+ArrowLeft` move to the line start, `Alt+Backspace` deletes a word. `Bun.WebView` sends
  `Meta+a`/`Meta+z` as bare key events, so bowser runs the select-all, undo or redo itself unless
  the page cancelled the keydown. A key WebKit cannot press (`F1`, `Shift` alone, `KeyA`) and an
  unknown modifier (`shift`, `Cmd`) now fail with `usage:` and exit 1 instead of exit 2.
  `Meta+c`/`x`/`v` fire the keydown but do not touch the clipboard. (#55)
- **A first `goto` whose server never answers no longer leaves the session stuck.** In a session
  that had not loaded a page yet, the recovery after a timeout reloaded the page, but WebKit has
  nothing to reload before the first page commits, so the reload did nothing; and `Bun.WebView`
  refuses a new navigation while one is pending. Every later command then failed at its budget
  until `close`. Recovery now has such a page leave for `about:blank`, which cancels the stuck
  navigation; the next `goto` works once recovery has run. (#48)
- **An `eval` that never settles in a fresh session no longer leaves the session stuck.** Before
  the first page, recovery left the initial page with a script, but WebKit refuses a second
  script while the stuck one is pending, so nothing freed it and every later command failed until
  `close`. Recovery now falls back to navigating to `about:blank`, which frees the stuck `eval`
  about 3 s later; the session then answers on `about:blank`. (#67)
- **`--json` dialog reports carry only bowser's own fields.** A page can write to the log the
  dialog shim keeps, and its extra keys (`"note": …`, an object `answer`) came out in the reply as
  if bowser had written them. Each report is now rebuilt from `type` (`alert`, `confirm` or
  `prompt`; any other entry is dropped), `message`, `state`, and `defaultValue`, `answer` and
  `unanswered` when they have the documented type. (F27)
- **`BOWSER_DAEMON_DEBUG=1` no longer hangs a command whose output is piped.** The daemon got the
  caller's stdout and stderr, and since it runs until `close`, `bowser open … | cat`, `$(…)` and an
  agent's shell tool waited for it forever. Its output now goes to
  `~/.bowser/sessions/<session>/daemon.log`, and a daemon that does not start in time names that
  file in the error. (F6)
- **`state-load` checks the file's shape and names the field that is wrong.** A file whose
  `origins` was an object, or whose top level was `null`, failed with an engine message
  (`{} is not iterable`); one with `"cookies": "nope"`, a `localStorage` object or an entry with
  no `value` reported "loaded" and restored nothing, or stored the string `"undefined"`. Such a
  file now fails before anything is restored, with `playwright-cli`'s wording:
  `state-load: storageState.origins[0].localStorage[0].value: expected string, got undefined`.
  (F5)
- **`resize` over 16384 is a usage error.** `Bun.WebView` refuses a side over 16384, so
  `resize 16385 100` failed in the daemon with `The value of "width" is out of range` and exit 2.
  It now fails before connecting, with `usage: bowser resize <width> <height> (each 1 to 16384)`
  and exit 1. `playwright-cli` has no such limit; the limit is `Bun.WebView`'s. (F22)
- **`state-save` before the first page writes an empty file.** On `about:blank` WebKit refuses
  to read localStorage, so `state-save` failed with `localStorage: The operation is insecure.`
  and exit 2, and wrote nothing. It now writes `{"cookies": [], "origins": []}`, as
  `playwright-cli` does. (F33)
- **A session name too long for this `HOME` is a usage error.** A name over 255 characters failed
  in `mkdir` with a raw `ENAMETOOLONG` (exit 2). Under a very long `HOME` a shorter name could fail
  too: its daemon died claiming `<session dir>/pid.<pid>.tmp`, which must fit Bun's 1016-character
  path limit, and `open` reported only "did not start in time". Creating a session now checks the
  name first and fails with `usage: session name is too long for this HOME: at most N characters
  under <sessions root>, got M` (exit 1), before any daemon starts. `close`, `close --all` and
  `list` still handle an existing directory with such a name. Every name that worked still works.
  (F35)
- **`snapshot --filename` under `--json` and over MCP answers JSON.** It printed the plain
  `wrote /…/f` and wrote the `{"snapshot": …}` JSON to the file. It now answers
  `{"ok":true,"filename":"/…/f"}`, as `screenshot` does (with `"dialogs"` when a dialog was
  answered), and the file always holds the `### Page` text, Modal state lines included. (F38)

- **MCP `initialize` answers with a protocol version bowser supports.** It echoed whatever the
  client sent, `"1999-bogus"` included. It now answers the client's version when it is
  `2025-11-25`, `2025-06-18` or `2024-11-05`, and `2025-11-25` otherwise, as the MCP lifecycle
  requires. `2025-03-26` is not offered: it requires JSON-RPC batches, which bowser does not take.
  The stateless `2026-07-28` revision is not implemented: its `server/discover` probe gets
  `-32601`, and the client falls back to `initialize`. (F39)

- **An MCP batch or a non-object message gets an error instead of silence.** An array, a number, a
  string or `null` was taken for a notification and got no reply, so a client that sent a batch
  waited forever for its ids. Such a line now gets one `-32600 Invalid Request` with `id: null`,
  as JSON-RPC requires; nothing in a batch runs. (F40)

- **MCP tool arguments of the wrong type are refused, not converted or dropped.** `session: 42`
  ran on the `default` session, an object went to the page as `"[object Object]"`,
  `persistent: "false"` or `1` was dropped without a word, and an unknown key was ignored. Each
  argument is now checked against the tool's input schema, and a wrong one gets an `isError`
  result such as `usage: argument 'session' of 'eval' must be a non-empty string, got number`,
  without running anything, as MCP's SEP-1303 asks. A finite number is still taken where the
  schema says string, so `resize {width: 800, height: 600}` keeps working. (F42)

- **`bowser mcp` exits quietly when its client goes away.** A client that closed its end of the
  server's stdout crashed the server at the next response, with an `EPIPE` stack trace and exit
  1, and a call queued behind the running one still ran for no one. The server now exits 0 at the
  first failed write, before a queued call starts; a browser operation already running finishes
  in its daemon, as a cancelled call's does. (F41)

## [0.8.2] — 2026-09-27

### Fixed

- **`close` keeps a localStorage write made just before it, in a persistent session.** WebKit
  commits localStorage 500 ms after a write, and the browser is killed when the daemon exits, so
  with `--persistent` or `--profile` a write in the last half second before `close` was lost
  (2 in 10 runs of `tests/e2e-persistent.test.ts` under load). `close` now leaves the page and
  waits 1 s before closing the view, so it takes about a second longer for a persistent
  session. (#61)
- **`open` and `goto` of a URL over ~8 KB no longer hang.** In Bun 1.4.2 a reply over 8 KB from
  the browser sometimes arrived only when Bun sent the browser its next message
  (oven-sh/bun#44134), so with a long `data:` URL about 1 `goto` in 10 under load waited out its
  op budget. When a browser call has been pending for 1 s, bowser now opens a second, 1x1 view
  and sends it a no-op every 100 ms while calls are pending, which releases the reply. 0 hangs in
  1200 opens and gotos and 600 link clicks under the same load; a stalled one takes about 1.1 s. A
  session whose calls all answer within 1 s never opens that view (it costs a WebKit content
  process, ~25 MB); a session that does keeps it until `close`. (#63)

## [0.8.1] — 2026-09-27

### Fixed

- **A password field's `value` attribute could reach the snapshot.** An `<input type="password" role="spinbutton" value="…">` that another element names with `aria-labelledby` put its initial value into that element's name, bypassing the password guard. The walker now treats it like any password field. Found by the Codex review of PR #59; present since the full-tree snapshot.

- **The URL bowser reports follows `history.pushState`.** After a same-document URL change
  (`pushState`, `replaceState`, a hash change), `click`'s reply, `state.json` and every command
  that reports the page URL gave the old URL while `snapshot` showed the new one. The URL is now
  read from the page's `location.href`. (#51)
- **`select`, `check` and `uncheck` wait for a navigation their page handler starts.** A
  `<select onchange="location.href = …">`, or a checkbox with the same handler, left the next
  `snapshot` on the old page until the new one arrived. They now wait for it, as `click` and
  `press` do. `hover` and `type` wait the same way. Each of these that does not navigate now
  takes about 100 ms longer. (#51)
- **A page error exits 2, whatever its text.** `eval` (or `run-code`) of a page that throws
  `usage: …`, `ref 'e1' not found …` or `no open page …` exited 1, as if the command line were
  wrong, because the exit code was read from the message. The code is now set where bowser raises
  the error: its own user errors exit 1, everything else exits 2. No message text changed. (#51)

### Changed

- **A saved ref no longer carries a CSS selector.** Ref commands already act on the element the
  live page resolves for the ref, so `snapshot` stops writing `selector` into `state.json`'s refs.
  A `state.json` written by 0.8.0 still loads; its `selector` fields are ignored. (#51)

## [0.8.0] — 2026-09-27

### BREAKING: no release binaries; install through npm or from source

A release binary is ad-hoc signed with no Team ID, so Gatekeeper rejects it, and a downloaded copy
(with `com.apple.quarantine` set) hung on `--help` with no output.

- **Releases no longer build or attach binaries.** A GitHub Release carries its notes and no
  assets. bowser installs with `npm install -g @drakulavich/bowser-cli`, or from source.
- **Migrating from a binary:** run `bowser close --all` with the old binary, delete it, then
  `npm i -g @drakulavich/bowser-cli`. `close` still recognises a daemon an old binary started.
- **The npm package needs Bun ≥ 1.4.2 on `PATH`.** npm does not enforce `engines.bun`, so a
  command that would start a session on an older Bun, or on one without `Bun.WebView`, now fails
  at once with `bowser requires Bun >=1.4.2 (found <version>)` (exit 1) instead of `did not start
  in time`. The floor is read from `engines.bun`.
- The hidden `--daemon` entry and the `build` script are gone. The daemon always runs as
  `bun <package>/src/daemon/main.ts <session>`.

### Changed: a session started by another bowser version is refused

After an upgrade, the new CLI drove the old version's still-running daemon: an op the old daemon
lacked failed with `unknown op`, and the rest ran with the old behaviour (a `prompt` was dismissed
with no report).

- **The daemon answers `ping` with its version.** A command that finds a daemon of another version,
  or one from before this change, fails before it sends anything else: `session '<name>' is running
  bowser <v> (this is <w>); run 'bowser close -s <name>', then open it again` (exit 1). `open` is
  refused too: it cannot restart the daemon without dropping its page.
- `close`, `close --all` and `list` skip the check, so an old daemon is still listed and shut down.
  Run `bowser close --all` before you upgrade.

### Fixed

- **`close` no longer orphans a silent daemon from bowser 0.5 or older.** Such a daemon wrote no
  pidfile, and when it accepted the connection but never answered, `close` removed the session and
  reported success while the process ran on. It now fails with exit 2 and keeps the session: `close:
  session '<name>' has no pidfile (a daemon from bowser 0.5 or older) and its daemon did not answer;
  find it with 'pgrep -fl -- "--daemon <name>"', end it, then run close again`. `close --all`
  reports it as a failed session. A socket nobody listens on is still removed.
- **`list` returns at once with live sessions.** It took about 1 s whenever a session was live: a
  second probe left a 1 s timer running after the answer was printed.
- **A timeout names the command you ran.** `fill` timed out as `operation 'click' timed out after
  3000ms`; it now reads `'fill' timed out after 3000ms (in its 'click' step)`. The step is left out
  when the command and the op share a name. A queued timeout keeps its `(waiting for '<op>', …)`
  tail. Exit code unchanged (2).
- **`BOWSER_OP_TIMEOUT_MS` is documented as read when the session starts.** Setting it on a later
  command did nothing, silently. It is still one budget per session: to change it, `close` and
  `open` again.
- **`press Tab` moves focus.** It typed a tab character into the focused field, and from `<body>`
  focused nothing; the page saw no `keydown`. It now moves focus as the browser's own Tab does, the
  field's value unchanged, and a page `keydown` listener sees a trusted `Tab`. Other keys are
  unchanged.
- **`click`, `check` and `uncheck` refuse a disabled element.** They reported success and did
  nothing, and `check` on an `aria-disabled` checkbox ran its click handler. A disabled element, by
  the rule the snapshot uses for `[disabled]` (a disabled control or `<fieldset>`, or
  `aria-disabled="true"` on it or an ancestor), now fails at once with `ref 'eN' is disabled`
  (exit 1), and nothing is clicked. `playwright-cli` waits out its timeout instead.
- **`uncheck` refuses a checked radio.** It clicked it, reported `unchecked`, and the radio stayed
  checked. It now fails with `ref 'eN' is a radio button; select another option in its group to
  uncheck it` (exit 1), as `playwright-cli` does. On an unchecked radio it succeeds and does
  nothing. `check` and `uncheck` read `aria-checked` on an element that is not an `<input>`, so
  `check` on an `aria-checked="true"` checkbox no longer clicks it off.
- **`uncheck` unchecks an `aria-checked="mixed"` checkbox.** It read mixed as unchecked, clicked
  nothing and reported success. Mixed now counts as checked for `uncheck`, which clicks until the
  element reads `false` (twice for the usual mixed → true → false cycle). `check` on mixed clicks
  once, as `playwright-cli` does. `playwright-cli`'s `uncheck` leaves a mixed checkbox as it is.
- **An SVG `<title>` names the SVG.** A link or button whose only content is an
  `<svg><title>Logo</title>…</svg>` printed with no name (`link [ref=e2]`); it now prints
  `link "Logo"`, with `img "Logo"` inside, as `playwright-cli` does. An `<svg>` or an element
  inside one takes its first child `<title>`, after `aria-labelledby` and `aria-label`.
- **`screenshot` is documented as the viewport.** The docs, `--help` and the MCP tool said
  full-page; `Bun.WebView` captures the viewport only, which is also `playwright-cli`'s default.
  The behaviour is unchanged. The summary now reads "Save a PNG screenshot of the viewport".
- **`run-code` prints what the code gives.** The code was the body of a plain function, so the
  documented IIFE form (`(() => { return 5 })()`) and `async page => …` printed an empty line, and
  `await` was a syntax error. Code that is one expression is now evaluated as one and prints its
  value; other code is the body of an async function, where `return` gives the result and `await`
  works. A result that is a function, such as a `playwright-cli` snippet `async page => …`, fails
  with `run-code runs JavaScript in the page and has no Playwright 'page'; write statements and use
  return` (exit 1). `run-code` runs in the page, unlike `playwright-cli`'s, which runs Playwright
  code in Node.
- **A crashed page is reported.** After the page's web process died a second time, every page
  command failed with `JavaScript execution returned a result of an unsupported type` (exit 2). It
  now fails with `the page crashed (its web process exited); run 'bowser reload' or 'bowser goto
  <url>'` (exit 2). The page is not reloaded for you; `reload`, `goto` and `open <url>` recover it.
  The first crash is still not reported: WebKit reloads the page, which nothing tells apart from a
  page reloading itself.

## [0.7.0] — 2026-09-27

### Changed: extra arguments are an error

- **A command given more arguments than it takes fails** with `usage: too many arguments for '<cmd>':
  expected <n>, received <m>` (exit 1), before it starts or reaches a browser. The extra words used
  to be dropped silently: `eval 1 + 1` printed `1`, `goto <url> extra` navigated, `localstorage-set a
  b c` set `a`, and `fill e4 hello world` filled `hello`. Words after `--` count too. Quote an
  argument with spaces. `bowser mcp extra` no longer starts the server. MCP tool calls are
  unaffected.

### Changed: `fill` and `type` never echo the text they entered

Through MCP, `fill` and `type` returned the text they entered, passwords included, so a secret
landed in the agent's context twice. MCP has no `--stdin` path to avoid it.

- **`fill --json`** gives `{"ok":true,"ref":"<ref>"}` in every mode, the shape `--stdin` already
  had. The `text` key is gone. The plain output, `filled <ref> (<role> "<name>")`, is unchanged.
- **`type`** prints `typed N characters` (`typed 1 character` when N is 1), where N counts code
  points, instead of `typed "<text>"`. `type --json` gives `{"ok":true,"length":N}` instead of
  `{"ok":true,"text":"<text>"}`.
- The MCP `fill` and `type` tools follow, since they return the `--json` answer.
- A browser error from either command that contains the entered text is replaced by
  `<command>: the browser's error message was withheld because it contained the entered text`
  (exit 2, dialogs still reported). Dialog messages are page content and are printed as is.

### Changed: a session whose browser exited refuses commands

- **After its browser exits, a session refuses every command but `open` and `close`** with
  `session '<name>' is not open (its browser exited); run 'bowser open'` (exit 1). Any command used
  to start a new, empty in-memory browser and exit 0: after a crash, a `--persistent` session
  silently lost everything done until the next `open --persistent`. `bowser open` starts it anew,
  `bowser close` clears it. A session that never ran a browser still starts one on its first
  command. Session directories left behind by earlier versions refuse too, until `open` or `close`.

### Changed: `close --all` fails when a session could not be closed

- **`close --all` exits 2 when it could not close a session**, the exit code a single `close` of it
  gives. It still tries every session, then prints the ones it closed and each failure with its
  reason. Under `--json` the failure is plain text on stderr, like every other error. It used to
  exit 0 with only the names (`{"ok":false,…}` under `--json`). With no failures nothing changes.

### Changed: file outputs report their absolute path

- **`screenshot` and `snapshot --filename` report the absolute path they wrote**, on the CLI and
  over MCP (`wrote /…/shot.png`, `{"ok":true,"filename":"/…/shot.png"}`), as `state-save` already
  did.

### Fixed

- **Concurrent first commands on a session start one browser.** Five `open`s at once on a new
  session left two or three daemons, and `close` ended only one; a losing daemon could also delete
  the winner's pidfile. The daemon now claims the session through its pidfile before anything else,
  and a newcomer that finds a live daemon holding it exits. A daemon whose socket file was deleted
  is no longer replaced by a second one: the next command fails with `did not start in time` until
  `bowser close`.
- **`bowser mcp` started from `/` or an unwritable directory writes its files.** `screenshot`,
  `snapshot` with `filename` and `state-save` failed with `EROFS`. The server now works in
  `<os.tmpdir()>/bowser-mcp` in that case, and every reply names the absolute path.
- **A dialog that fires between commands is no longer lost when the next command leaves the page.**
  A timer's `confirm`, then `reload`, `goto`, `open`, `go-back` or `press Enter` submitting a form,
  used to report nothing: the report left with the old page. That command now reports it under
  `### Modal state`, and a later `go-back` to the cached page does not report it again.
- **A page's own `window.alert`, `confirm` or `prompt` runs.** bowser replaced it with its dialog
  handler, so a page's in-page modal or test stub never ran and its caller got `false`. bowser now
  replaces only the browser's own functions, as `playwright-cli` leaves the page's alone. A page
  wrapper that calls a saved browser function (`const c = confirm; window.confirm = m => c(m)`) is
  dismissed by WebKit and not reported, like a saved reference.
- **A dialog in a same-origin iframe is reported and takes the prepared answer.** It used to be
  dismissed unreported, and the answer set by `dialog-accept` carried over to the next top-level
  dialog. A dialog in a cross-origin iframe, or one that loaded after bowser's last command, is
  still dismissed and not reported, and the answer still waits.
- **`select` matches an option's value or its label**, as `playwright-cli` does: `select e3 Red`
  picks `<option value="r">Red</option>`, the first match in document order. A text that matches
  no option fails at once with `ref 'eN' has no option "<text>"` (exit 1), and the select keeps its
  value. Both used to report success and leave the select with nothing selected.
- **`fill` refuses a disabled or read-only field** with `ref 'eN' is not an editable element
  (disabled)` or `(readonly)` (exit 1). A disabled `<fieldset>` counts. It used to report success
  and empty the field. `playwright-cli` waits out its timeout instead.
- **`fill` sets `date`, `time`, `datetime-local`, `month`, `week` and `color` inputs**, as
  `playwright-cli` does: `fill e9 2024-01-02` used to report success and leave the date empty. A
  value the input does not keep (`fill e9 tomorrow`) fails with `ref 'eN' did not accept the value
  for input[type=date]`, and text that is not a number on `type=number` fails with `ref 'eN' needs
  a number (input[type=number])`, both exit 1 with the value unchanged and without the text in the
  message. Both used to report success.
- **`open` and `goto` add a scheme to a URL typed without one**, as `playwright-cli` does:
  `example.com` goes to `https://example.com`, and `localhost:3000/x`, `127.0.0.1:3000` and
  `[::1]:3000` go to `http://…`. `open example.com` failed with `The URL can’t be shown`, and
  `goto localhost:<port>/x` timed out, because WebKit read `localhost:` as a scheme. A URL with a
  scheme is used as typed. `playwright-cli` gives `127.0.0.1` `https://`; bowser gives it `http://`.
- **`<command> --help` prints that command's help and runs nothing.** It used to run the command:
  `close --help` closed the session, `open --help` opened one, and `mcp --help` started the MCP
  server. `-h`/`--help` anywhere before `--` now prints the usage line, summary, arguments and flags
  from the registry, and exits 0. With no command it prints the general help, as before.
- **A command that times out no longer wedges the session.** `BOWSER_OP_TIMEOUT_MS` only bounded
  the running operation, and the next one waited for it to finish: after an `eval` that never
  settled, or a `goto` whose server never answered, every later command hung until `close`. The
  budget now counts the time a command waits behind another one. A command still waiting at its
  deadline fails (exit 2) with `operation '<op>' timed out after <ms>ms (waiting for '<prev op>',
  which timed out and is still running; run 'bowser close' if the session stays stuck)`. If the
  timed-out command is still running 2 s later (or after the budget, if that is shorter), the
  daemon reloads the page once to free the browser; one that was only slow and finishes within
  that time keeps its page. The reload cancels a navigation that never settles and ends an
  evaluation waiting on a promise that never settles, and the session then keeps working on the
  reloaded page. A page stuck in a synchronous loop cannot be
  interrupted: later commands fail fast until it ends, or until `bowser close`, which always works.
- **`click` and `press` wait for a navigation to a slow server.** A click on a link whose server
  answered after 3 s returned at once, and the next `snapshot` showed the old page and its old
  refs. The start of a navigation is now read from the page, so the command waits for the new page
  to land, up to 10 s, including when the page's script replaces that navigation with another one.
  A click that navigates nowhere still returns after 100 ms.
- **`click` and `fill` reach an element below the fold or under a fixed header.** They timed out
  after 30 s on an element outside the viewport, or one whose centre another element covered. Every
  ref action now scrolls such an element to the centre first, as
  `playwright-cli` does, in the same page script that resolves the ref, so it costs no extra round
  trip.
- **One slow MCP tool call no longer freezes `bowser mcp`.** The server handled one request at a
  time, so while a call to one session ran, `ping` and calls to other sessions waited for it (35.6 s
  in the repro). `initialize`, `ping`, `tools/list` and notifications are now answered at once;
  tool calls for different sessions run at the same time, and calls for one session still run in
  arrival order. Responses can therefore arrive out of order, which JSON-RPC allows.
  `notifications/cancelled` is now honoured: a queued call never runs, a running call's result is
  dropped, and neither gets a response. A browser operation that has started is not undone.

## [0.6.0] — 2026-09-26

### BREAKING: WebKit only, macOS only

bowser now drives only native WebKit through `Bun.WebView`, with no browser download. The Chrome
backend is removed. If you need Chromium, use Microsoft's
[`playwright-cli`](https://github.com/microsoft/playwright-cli), whose commands bowser mirrors.

- **macOS only.** `Bun.WebView`'s WebKit backend exists only on macOS. On another platform, any
  command that would start a session fails with `bowser requires macOS (WebKit)` (exit 1);
  `--help` and the MCP tool listing still work. `package.json` declares
  `"os": ["darwin"]`.
- **No Linux binaries.** Releases ship `bowser-macos-arm64` and `bowser-macos-x64` only.
- **Removed commands:** `install` (it downloaded Chromium), and `cookie-list`, `cookie-get`,
  `cookie-set`, `cookie-delete` and `cookie-clear` (`Bun.WebView` reaches cookies only through
  CDP, which WebKit does not have). Each now gives `unknown command` (exit 1).
- **`state-save` / `state-load` keep only localStorage.** The file is still Playwright's
  `storageState`: `state-save` writes `"cookies": []`, and `state-load` restores localStorage and
  skips any cookies with one stderr line, `N cookies skipped (bowser has no cookie access on WebKit;
  use open --persistent)`. To keep a login between sessions, use `open --persistent` or
  `open --profile=<dir>`, which keep cookies on disk.
- **Removed environment variables:** `BOWSER_BACKEND`, `BOWSER_CHROMIUM_PATH` and
  `BOWSER_CHROME_ARGS`. Nothing reads them any more.
- **`BOWSER_CHROME_DEBUG` is renamed `BOWSER_DAEMON_DEBUG`.** It still lets the daemon's output
  through to the terminal.

### Added

- **`dialog-accept [text]` and `dialog-dismiss`** set the answer for the next `alert`, `confirm` or
  `prompt` on the current page. A prompt gets `text`, or its own default value when no text is given.
  Every dialog is answered the moment it opens: with that one-shot answer if one is set, otherwise
  it is dismissed. The command that caused a dialog reports it under `### Modal state`, for example
  `- ["confirm" dialog with message "sure?"]: accepted`, and `--json` gives a `dialogs` array. A command that fails prints them on stderr after its error,
  with the same exit code. The
  answer is used once and dropped when the page navigates. **Difference from `playwright-cli`:**
  run the command *before* the action that opens the dialog. Run after it, it prepares the next
  dialog and does not answer the one already reported. WebKit has no dialog events, so a page shim
  answers dialogs. A dialog raised during page load, before bowser's first command on that
  document, is dismissed by the engine and not reported. A dialog whose handler then navigates the
  page is answered but not reported. So is a dialog opened through a reference the page saved at
  load time, which the engine dismisses; a prepared answer then stays set until the next dialog
  bowser sees or a navigation.

- **`fill <ref> --stdin`** takes the text from standard input, so a secret never reaches the
  `bowser` process's arguments, where `ps` shows it to any local user:
  `op read op://vault/site/password | bowser fill e4 --stdin`. One trailing `\n` or `\r\n` is
  dropped and everything else is kept as is. The text is not echoed: the plain answer is unchanged
  and `--json` answers `{"ok":true,"ref":"e4"}` with no `text`. `--stdin` together with a `<text>`,
  or with a terminal as input, is a usage error (exit 1). The MCP `fill` tool does not offer it.
  This is a bowser-only extension; `fill <ref> <text>` is unchanged. `snapshot` hides a password
  field's value (see Changed below); other fields' values still print.
- **`open --persistent` and `open --profile=<dir>`**, as in `playwright-cli` 0.1.13. A session's
  browser keeps cookies, `localStorage` and IndexedDB on disk, in `~/.bowser/profiles/<session>/` or
  in `<dir>`, so a login survives `close` and daemon restarts. `close` leaves the
  profile in place; delete it with `rm -rf`. Opening a running session with a different store is a
  usage error (exit 1): close it first. One profile serves one running session at a time.

### Changed

- **`snapshot` never shows a password field's value.** A filled `<input type="password">` (any case
  of `type`) prints as a leaf such as `textbox "Password" [ref=e3]`, `state.json` keeps no `value`
  for its ref, and an `aria-labelledby` reference to it adds nothing to another element's name.
  Before, a secret passed to `fill` showed up in the next `snapshot` (plain and `--json`) and on
  disk. A deliberate difference from `playwright-cli`, which prints the value; `eval` can still
  read it on purpose.

### Breaking

- **`snapshot` prints the full aria tree in `playwright-cli`'s format.** It printed only
  interactive elements under landmarks, so an agent could not read page text, headings, checkbox
  state or placeholders without extra `eval` calls, and prompts written for `playwright-cli` did
  not carry over. The output now has `playwright-cli` 0.1.x's `### Page` / `- Page URL:` /
  `- Page Title:` / `### Snapshot` header and a fenced tree with headings, text, state attributes
  (`[checked]`, `[disabled]`, `[expanded]`, `[active]`, `[level=N]`, `[pressed]`,
  `[selected]`) and `/url` / `/placeholder` props. Goldens captured from `playwright-cli` 0.1.13
  pin it byte-for-byte. What breaks:
  - **Line syntax.** `button "Add": [ref=e2]` is now `button "Add" [ref=e5] [cursor=pointer]`.
  - **Refs.** Any visible element can have one, not only interactive ones. They are numbered in
    document order across the whole tree, so the printed numbers have gaps, and they are sticky:
    an element keeps its ref across snapshots of one document while its role and name are
    unchanged. A navigation or reload starts again at `e1`.
  - **`--json`** prints `{"snapshot": "<tree>"}`; the `url`, `title` and `refs` keys are gone.
  - **`--depth=0`** is now valid and means unlimited, like no flag; it was a usage error.
  - **Actions check the ref's kind.** Since a ref can now be a listitem or a paragraph, `check`
    and `uncheck` accept only a checkbox, radio, switch or checkable menu item, `select` only a
    `<select>`, and `fill` only an `<input>`, `<textarea>` or contenteditable element. Any other
    ref exits 1 with `ref 'eN' is not …` before anything reaches the browser; before, `check` on
    a listitem clicked it and reported success.

  Not covered: iframe contents (an iframe prints as a leaf with a ref), shadow DOM, `aria-owns`,
  the `- Console:` line and the global `--raw` flag.

### Fixed

- **Dialogs went unreported.** WebKit answered them silently, so the agent never learned of them.
  They are now answered as they open and reported (see `dialog-accept` under Added).

- **An action on a stale ref waited 30 s or hit the wrong element.** A ref was acted on through
  the CSS path saved at snapshot time. When its element was gone (a todo removed by "Clear
  completed"), `click` waited out the op timeout and exited 2; when the list shifted, the path
  matched the next element and the action landed there. The snapshot now keeps a reference to
  each ref's element, and `click`, `fill`, `hover`, `select`, `check` and `uncheck` first ask the
  page for that element's current path. A ref whose element is gone, including every ref from
  before a navigation or reload, fails at once with `ref 'eN' not found in the current page snapshot. Try capturing new snapshot.`
  and exit code 1, the message `playwright-cli` prints. It costs one more daemon round trip per
  ref action.

- **A session name was never checked for containment.** `-s` reached the filesystem unfiltered, so
  `bowser -s ../../Documents close` resolved outside `~/.bowser/sessions` — harmless while `close`
  only rewrote a state file, and a recursive delete once it removed the directory. `sessionDir()`
  now accepts only letters, digits, `.`, `_` and `-`, never `.` or `-` first, and
  `socketPath()`/`pidPath()` are built from it, so every session path bowser forms is checked in
  one place. The same rule keeps `close` from mistaking one daemon for another: a session named
  `--daemon victim` would have run as `bowser --daemon --daemon victim`, which `ps` shows exactly
  like the daemon for `victim`. **Breaking:** names with spaces or other punctuation are refused.
  `close --all` still removes a directory left under such a name, unless the pid recorded in it
  is alive: that daemon can no longer be identified, so it is never signalled and its directory
  stays for a person to deal with.

- **A wedged daemon hung every command.** `connectOrSpawn`'s health-check `ping` had no timeout: a
  daemon that accepted the connection and never answered — stopped, or blocked in a syscall — hung
  the caller forever, and the unclosed socket kept the process from exiting even after that. The
  check now gives up after a second and treats the daemon as unreachable, which every caller
  already handles.

- **`close` could report success while leaving a browser process running.** It connected to the
  daemon with `spawn: false`, swallowed a failure to connect as "no daemon; that's ok", unlinked
  the socket and printed `closed session '<name>'`. A daemon that was running but unreachable was
  left orphaned — holding a browser view, addressable by no command, found only with `pgrep`. The
  daemon now records its pid beside its socket; `close` waits for that process to go, ends it if it
  does not, and throws rather than claim success when it cannot confirm it stopped. Nothing is
  signalled until the pid's command line is confirmed to name this session and a bowser daemon,
  so a stale pidfile whose number has been reused cannot cost an unrelated process.

- **WebKit: `open` printed an empty title.** `Bun.WebView`'s `title` getter is still empty when
  `navigate()` resolves; the daemon now reads `document.title` from the page
  when the getter is empty, the same fallback `realUrl()` uses for the URL.
- **WebKit: `goto` right after `reload` failed with `NSURLErrorDomain -999`.** `reload` now waits for
  its navigation to land before answering (native `Bun.WebView.reload()` is used where the runtime
  has it, but like `goBack()` it resolves before the reload commits).
- **`click`, `press`, `go-back`, `go-forward` and `reload` reported the URL of the page they were
  leaving.** The browser now waits for a navigation the action started (begins within 100 ms, lands
  within 10 s) before answering.

### Changed

- **`list` shows only sessions whose daemon answers.** It listed every session directory, and
  nothing removed one, so the output grew without bound — 640 lines on the machine where this was
  found, 2 of which named a session an agent could use. Liveness is asked of the daemon, not read
  off the filesystem: a stale socket outlives a crashed daemon and an orphan holds no socket.

- **`close` removes the session directory** instead of rewriting its state file empty. Nothing
  reads a closed session's state, and keeping the directory is what let closed sessions accumulate.

- **A command reads its string flags through `str()`** instead of asserting them with
  `as string | undefined`. Flags arrive as `string | boolean` in one bag, so the cast also accepted a
  boolean: a flag declared `kind: "boolean"` could be read as a string and the command handed `true`.
  `src/cli/schemas.ts`, a one-line re-export left over from the registry move, is deleted.
- **Type checking is a gate.** `bun run typecheck` (tsc) runs in CI; `bun test` strips types and
  never checked them. Three latent type errors fixed.
- **WebKit is tested end-to-end.** A macOS CI job runs the e2e suites on WebKit, including a
  new agent-loop scenario covering every command, and a differential test against
  `playwright-cli` (skipped when it is not installed).
- **Known WebKit limitations, now pinned as `test.todo`:** `press` fires no bubbling `keydown`. See
  the 2026-09-05 refactor spec, "Findings".
- **Daemon protocol is one typed map.** `src/daemon.ts` is now `src/daemon/{protocol,server,client,main}.ts`.
  `DaemonOps` declares every op's arguments and result; the client's `request`, the server's handler
  table and the tests' fake client derive from it, so a new op without a handler fails `bun run
  typecheck`. No wire, CLI or `--json` change.
- **`src/commands.ts` is now `src/commands/{context,navigation,interaction,snapshot,dialog,web-storage,storage-state,scripting}.ts`**,
  and every script injected into the page lives in `src/page-scripts.ts`. `reply()` and `syncState()` in
  `context.ts` replace the two lines every command repeated. No output, `--json` or wire change.
- **Each command carries its own one-line summary, now the single source for `--help` and the MCP
  tool description.** `list`'s summary is now one string serving both, where the MCP tool
  description had carried a stale `"List active sessions"` of its own. (What `list` enumerates
  changed later in this release — see "`list` shows only sessions whose daemon answers" above.)
- **Commands are a registry.** Each `src/commands/<domain>.ts` exports `Command` objects; dispatch,
  `bowser --help` and the MCP tool list are generated from them. `src/cli.ts`'s 39-case switch, the
  hand-written help text, and `DESCRIPTIONS`/`MCP_EXCLUDED` in `src/mcp.ts` are gone. Command names,
  argv shapes, exit codes and every command's output are unchanged.
- **`bowser --help` lists commands grouped by domain.** The registry concatenates each
  `commands/<domain>.ts`'s array, so navigation and session commands now come before `snapshot`
  and `screenshot` before the interaction commands, where the old hand-written order interleaved
  them. The MCP `tools/list` order follows the same grouping. No command was added or removed.
- **`bowser --help`'s column alignment changed.** The summary column now starts two spaces past the
  widest usage that still ends by column 40 (column 38), instead of a fixed width. Usages past it
  (`open`'s and `snapshot`'s) wrap onto their own line with the summary beneath. Every command's summary text is otherwise the same string used for its MCP tool
  description (see above).
- **The daemon's urgent lane is declared.** `ping` and `shutdown` carry `urgent: true` in
  `DaemonOps` and the server routes on that marker instead of testing for the string
  `"shutdown"`, so an op that must answer while another is wedged is one marker rather than a
  new branch. The routing itself moved out of `Bun.listen`'s `data` callback into an exported
  `dispatch(req, lane)` function in `src/daemon/server.ts`, so the lane choice can be
  unit-tested without a socket. No
  visible change: no command's output differs.

## [0.5.0] — 2026-06-15

### Added

- **`mcp`** — run a Model Context Protocol stdio server that exposes every browser command as an
  MCP tool, so MCP clients (Claude Desktop, etc.) can drive the browser without the CLI. Tools are
  generated by reflecting over the command schema table; each `tools/call` reconstructs a CLI argv
  and routes through the existing `run()` dispatcher (single source of truth for parsing, `--json`,
  daemon spawn, and errors). Hand-rolled newline-delimited JSON-RPC — zero runtime dependencies.
  `install` and `mcp` itself are excluded from the tool set; all other commands are exposed.
- **`resize <width> <height>`** — set the viewport size in pixels via the native
  `Bun.WebView.resize()`. Works on both the webkit and chrome backends. Validates that both
  dimensions are positive integers.
- **`state-save <file>` / `state-load <file>`** — dump and restore a Playwright-compatible
  `storageState` JSON: the full cookie jar plus per-origin localStorage. Files are interchangeable
  with Playwright's `storageState` (sessionStorage is intentionally excluded, as in Playwright).
  Save captures the current page's origin; load restores localStorage for origins matching the
  current page and reports any others as skipped (navigate to each, then load again). Cookies use
  the CDP `cookie-*` ops, so both commands require the chrome backend. Composed entirely in the
  command layer — no new daemon op.

## [0.4.0] — 2026-06-15

### Added

- **`eval <expression>`** — evaluate a JS expression in the current page and print the result.
  String results are printed as-is; other values are `JSON.stringify`'d; `undefined`/`null` prints nothing.
  `--json` wraps output in `{ ok, result }`. Uses the existing `evaluate` daemon op; no new protocol op needed.
- **`run-code <code>`** — run multi-statement JS in the current page by wrapping the user code in an
  IIFE (`(() => { <code> })()`), enabling `return` statements and variable declarations. Same output rules as `eval`.
- **`cookie-list [--domain=<d>] [--url=<u>]`** — list all cookies for the current page (default) or a
  specified scope. Text mode: `name=value` per line; `--json` returns the full CDP shape including all
  attributes. **HttpOnly cookies are first-class** — they are visible and indistinguishable from ordinary
  cookies (unlike `document.cookie`, which hides them). Requires the chrome backend.
- **`cookie-get <name> [--domain=<d>] [--url=<u>]`** — print a cookie's value (empty string if not found).
  `--json` returns `{ ok, cookie }` (full CDP shape) or `{ ok: false }`. HttpOnly cookies are visible.
  Requires the chrome backend.
- **`cookie-set <name> <value> [--domain=<d>] [--url=<u>] [--path=<p>] [--http-only] [--secure] [--same-site=Lax|Strict|None] [--expires=<unix-s>]`** — set one cookie.
  Defaults `--url` to the current page URL when neither `--domain` nor `--url` is given.
  `--http-only` sets the HttpOnly flag (the cookie will be invisible to `document.cookie`).
  Requires the chrome backend.
- **`cookie-delete <name> [--domain=<d>] [--url=<u>] [--path=<p>]`** — delete matching cookie(s).
  Requires the chrome backend.
- **`cookie-clear`** — wipe all browser cookies in the current session's Chrome profile.
  Requires the chrome backend.
- **`src/cdp/types.ts`** — `Cookie`, `CookieParam`, `DeleteCookieOptions` types mirroring the
  CDP Network domain; no runtime dependency.
- **`Browser.cdp()` / `Browser.cdpAvailable()`** — raw CDP access exposed on the `Browser`
  interface in `src/browser.ts`. Delegates to `Bun.WebView.cdp()` on the chrome backend; rejects
  with a clear error on webkit. Future CDP-based commands (tab management, network mocking, etc.)
  build on these methods.

  Implementation note: the design spec proposed a bespoke `src/cdp/client.ts` WebSocket transport
  and `src/cdp/launch.ts` stderr-scraper. At implementation time Bun 1.3.13's `Bun.WebView` was
  found to launch Chrome with `--remote-debugging-pipe` (no stderr `DevTools listening on ws://` line,
  no stderr hook API) and to expose `view.cdp()` natively. The bespoke transport was therefore
  unnecessary; `view.cdp()` is the supported path. The spec doc was updated accordingly.

## [0.3.0] — 2026-06-09

### Added

- `localstorage-list`, `localstorage-get`, `localstorage-set`,
  `localstorage-delete`, `localstorage-clear` — read and write the current
  page's `localStorage` from the CLI. Implemented via `evaluate` against the
  live page; selectors and values are JSON-escaped before injection.
- `sessionstorage-list`, `sessionstorage-get`, `sessionstorage-set`,
  `sessionstorage-delete`, `sessionstorage-clear` — same shape as the
  `localstorage-*` commands, targeting `sessionStorage`. Internally the
  two areas share a single storage helper in `src/commands.ts`.
- `bowser snapshot` now renders landmark nesting (`main`, `navigation`,
  `header`, `footer`, `section`, `article`, `aside`, `form`, `dialog`,
  `list`, `region`, …) as parent nodes in the aria-tree YAML.
- `--depth=N` is honored: `--depth=1` reproduces the flat v0.2 output;
  `--depth=2` keeps only the outermost landmark; default (omitted) is
  unbounded. `--depth=0` is rejected as a user error.
- **`close --all`** (`#7`): closes every open session in one command.
- **`BOWSER_OP_TIMEOUT_MS`** environment variable: sets the per-operation
  timeout in milliseconds (default `30000`; `0` disables). Useful when
  automating slow pages that would otherwise hang indefinitely.

### Changed

- The snapshot script returns a `path` array per ref (landmark ancestors,
  root-most first). `Ref.path` is optional in `state.json`; older state
  files without it remain valid and render flat.

### Fixed

- **Daemon operation serialization** (`#1`/`#3`/`#4`): the daemon now runs
  all operations one at a time through a promise-chain serializer
  (`src/serialize.ts`). Concurrent `evaluate()` calls into the single
  `Bun.WebView` no longer race or deadlock. A per-op timeout (controlled by
  `BOWSER_OP_TIMEOUT_MS`, default 30 s) surfaces wedged operations as a
  clear error instead of hanging.
- **`close [name]`** (`#6`): the positional session name is now honoured —
  `bowser close other-session` closes the named session rather than
  defaulting to `--session`.
- **`goto`/`open` URL reporting** (`#5`): on the chrome backend,
  `view.url` was returning `about:blank` even after a successful
  query-string navigation. The daemon now resolves the real URL via
  `location.href` (`realUrl()`) and fails loud when the page genuinely did
  not load.
- **Test hermeticity**: `sessionsRoot()` in `src/state.ts` now reads
  `process.env.HOME` at call time (matching `bowserCacheRoot()`), so tests
  that redirect `$HOME` via `process.env.HOME` see the temporary directory
  correctly.
- **`screenshot` now writes a valid PNG** (`#2`): decode the `Blob`
  returned by `Bun.WebView.screenshot()` (the old code stringified it to
  `"[object Blob]"`); the CLI writes the file so a relative `--filename`
  resolves against the user's cwd; default name auto-increments.
- **`shutdown` bypasses the op serializer** so `close` always works
  against a stuck daemon even when an operation is wedged in the serializer.
- **`socketPath` reuses `sessionsRoot()`** (`src/daemon.ts`) instead of
  re-computing the sessions root independently.
- **`screenshot` no longer hangs** (`#9`): the daemon ignored Bun's
  partial-write socket contract, so any response larger than the ~8 KB send
  buffer (a ~140 KB base64 PNG) was truncated mid-flight and the client hung
  until timeout. Socket writes now buffer the unsent remainder and flush it on
  `drain` (`src/socket-write.ts`), fixing every command in both directions
  (large snapshots and `localstorage`/`fill` values too). Screenshots are
  additionally written daemon-side and only the path is returned, keeping the
  PNG payload off the socket entirely.
- **Compiled-binary daemon spawn** (`#9`): a `bun build --compile` binary
  could not start its daemon — `import.meta.url` is a virtual `/$bunfs/` path
  that `Bun.spawn` cannot execute. The binary now re-invokes itself with a
  hidden `--daemon` flag. This path was never exercised by `bun test` (which
  runs in-process); a CI step now drives the real binary end-to-end.
- **Daemon-spawning commands no longer hang** (`#9`): `spawnDaemon()` never
  `unref()`'d the detached daemon subprocess, so Bun kept the parent CLI's event
  loop open waiting for a child that runs forever — `bowser open` on a fresh
  session printed its result and then hung instead of returning to the shell.
  `bun test` masked it (the runner force-exits); the real binary did not. The
  spawned process is now unref'd, and the compiled-binary CI step wraps each
  command in `timeout` so a regression fails fast instead of burning the job.

## [0.2.0] — 2026-04-26

### Breaking

- CLI surface is now command-compatible with Microsoft `playwright-cli` for the core agent loop. Existing `playwright-cli` skills work after replacing the binary name.
- `bowser snap` is renamed `bowser snapshot`.
- `bowser session show` and `bowser session list` are replaced by `bowser list`.
- The `@` ref prefix is dropped: refs are now bare `eN` (e.g., `bowser click e3`).
- `-i` / `--interactive` flag removed (snapshot output is always the aria-tree YAML).
- Snapshot YAML changed: aria-tree style with `[ref=eN]` markers.

### Added

- New commands: `goto`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `screenshot`, `go-back`, `go-forward`, `reload`.
- `--filename=path` for `snapshot` and `screenshot`.
- Long-form `--session=<name>` accepted alongside short form `-s=<name>`.

### Migration

| 0.1.0 | 0.2.0 |
|---|---|
| `bowser snap -i` | `bowser snapshot` |
| `bowser click @e3` | `bowser click e3` |
| `bowser --session app open …` | `bowser -s=app open …` |
| `bowser session list` | `bowser list` |
| `bowser session show` | (gone) — use `bowser list` plus `cat ~/.bowser/sessions/<n>/state.json` |

## [0.1.0] — 2026-04-19

First tagged release. An opinionated, Bun-native browser automation CLI for
AI agents.

### Added

- **Daemon architecture.** Each session runs a persistent `Bun.WebView`
  addressed over a Unix socket, so typed text, modals, cookies, and dynamic
  DOM survive across CLI invocations.
- **Core commands:** `bowser open`, `snap`, `click`, `fill`, `close`,
  `session [list|show]`.
- **`bowser install`.** Downloads a headless Chromium into
  `~/.bowser/chromium/` (delegating to Playwright's downloader but routing
  output into Bowser's own cache — no implicit scanning of your Playwright
  install). Skips if a Chromium is already found on the system; use
  `--force` to re-download.
- **Ref-based snapshots.** `bowser snap` tags interactive elements with
  `@e1`, `@e2`, … and persists **stable CSS paths** that survive reloads.
- **YAML + JSON output.** Human-readable by default, `--json` for agent
  pipelines.
- **Multi-session support** via `--session <name>`.
- **End-to-end examples.**
  - `tests/e2e.test.ts` — `data:` URL smoke test (no network).
  - `tests/e2e-todo.test.ts` — a local todo app served by `Bun.serve`,
    proving the daemon keeps state across `click` / `fill` commands.
  - `tests/e2e-search.test.ts` — live web: searches GitHub for OpenClaw and
    finds the repo link (gated behind `BOWSER_E2E_NET=1`).
- **CI** on GitHub Actions (unit + e2e jobs, Ubuntu).
- **Release workflow** that cross-compiles single-file binaries for
  Linux x64, macOS arm64, and macOS x64 on every `v*` tag push.
- **Bowser skill** (`skills/bowser/SKILL.md`) so agents can discover when to
  use Bowser without any MCP server.

### Notes

- Requires Bun ≥ 1.3.12 (for `Bun.WebView`).
- `bowser install` needs internet access and `bunx` on PATH.
- macOS uses system WebKit via `Bun.WebView` — nothing extra to install.
