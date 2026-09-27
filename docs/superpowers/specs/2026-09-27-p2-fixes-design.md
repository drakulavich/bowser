# Spec: P2 from the v0.6.0 exploratory testing: upgrades, lifecycle, actions, output, distribution

**Status:** approved 2026-09-27. The owner said "Двигай дальше" (go on) after 0.7.0 and ruled F7 himself (remove the binaries, npm only). The three open decisions below (F3, F21, F18) were ruled option 1; the other options stay for the record.
**Origin:** the P2 tier of the findings page from the v0.6.0 exploratory testing. The repros come from
the session sheets `S1.md`–`S5.md` of that run. They are restated below so this spec stands alone.

Every finding was rechecked on `main` at `d716565` (released as 0.7.0), with Bun 1.4.2:
- a binary compiled from `src/cli.ts`, and `bun src/cli.ts` where the source path matters;
- `HOME` set to a temporary directory;
- local pages served by `Bun.serve` on 127.0.0.1;
- the reference is `playwright-cli` 0.1.13 with `--browser=webkit`.

Results:
- 10 of the 12 findings still reproduce as measured.
- F30 does not: P1's pidfile claim (F29) fixed it (see F30).
- F7 was checked by its cause only. The v0.7.0 asset has the same ad-hoc signature, but the hang was
  not rerun (see F7). The owner has ruled on F7: release binaries go, and bowser ships only through
  npm and from source.

The tasks follow the brief's grouping. One change of order: do Task 4 (F7) first. It removes the
compiled binary's second spawn path, and F2's version check and the Bun guard then land in the one
`connectOrSpawn` that is left.

## Task 1: Upgrade and lifecycle

### F2: after an upgrade, the new CLI drives a still-running old daemon

**Measured.**
- Repro, with the real 0.5.0 release binary (SHA-256 matches the v0.5.0 asset digest) and the binary
  replaced the way an upgrade replaces it:
  ```sh
  cp bowser-0.5.0 bin/bowser
  bin/bowser -s=u2 open http://127.0.0.1:<port>/prompt   # a button that calls prompt('name?','dflt')
  rm bin/bowser && cp bowser-0.7.0 bin/bowser            # the upgrade
  bin/bowser -s=u2 dialog-accept x     # bowser: unknown op: dialog-answer        exit 2
  bin/bowser -s=u2 snapshot            # works: button "Ask" [ref=e2]
  bin/bowser -s=u2 click e2            # clicked e2 (button "Ask")                 exit 0, no dialog report
  bin/bowser -s=u2 eval "String(window.r)"   # null: the prompt was dismissed
  bin/bowser list                      # u2
  ```
- The 0.5 session directory holds only `sock` and `state.json`: 0.5 wrote no pidfile.
- On v0.6.0, S1 also drove a 0.5 **Chrome** daemon: the user agent was HeadlessChrome/147, though
  0.6 is WebKit only. Not rerun here: it needs 0.5's 192 MB Chromium download.
- Still reproduces on 0.7.0: yes (the repro above).
- Cause:
  - The client checks only that a daemon answers `ping` (`src/daemon/client.ts:172`).
  - Every daemon so far answers the same `"pong"`: 0.7 at `src/daemon/server.ts:157`, and 0.5 in
    `src/daemon.ts` at tag `v0.5.0`.
  - The client then sends ops the old daemon may not have. Commands whose ops exist in both versions
    run with the old daemon's behaviour.
- playwright-cli: its session records the version that started it. A client *older* than the session
  refuses: `Client is v<a>, session '<name>' is v<b>. Run playwright-cli open to restart the browser
  session.` A newer client runs, but its daemon executes the whole command, so no op can be missing
  (`isCompatible` in `playwright-core/lib/tools/cli-client/session.js`).

**Behaviour.**
1. The daemon answers `ping` with its package version (`version` in `package.json`).
2. When a daemon answers with a version other than the client's, or with no version (every daemon
   before this change), the command fails before it sends anything else:
   `session '<name>' is running bowser <v> (this is <w>); run 'bowser close -s <name>', then open it again`.
   For a daemon with no version, `<v>` reads `an older version`. It exits 1.
3. `close` and `close --all` skip the check, and still shut the old daemon down. Measured: a 0.5
   daemon that answers exits on 0.7's `close`. `list` skips it too, and lists the session.
4. `open` is refused like the other commands. It attaches to a running daemon, so it cannot restart it.
   The session is not restarted silently: that would drop the page, and F28 ruled against quiet resets.
5. The `cli.ts` exit-code regex gains the new message.

### F3: `close` reports success but orphans a 0.5 daemon with no pidfile

**Measured.**
- Repro, with the real 0.5.0 daemon made unresponsive by `SIGSTOP`. On v0.6.0 the daemon was wedged by
  a Chrome `prompt`, which needs 0.5's Chromium; `SIGSTOP` gives the same state, a socket that accepts
  and never answers:
  ```sh
  bowser-0.5.0 -s=c3 open http://127.0.0.1:<port>/     # no pidfile: sessions/c3 holds sock, state.json
  # upgrade the binary to 0.7.0
  kill -STOP <0.5 daemon pid>
  bowser -s=c3 snapshot    # daemon for session 'c3' did not answer; run 'bowser close -s c3' to stop it   exit 2
  bowser -s=c3 close       # closed session 'c3'   exit 0
  ls ~/.bowser/sessions/c3 # No such file or directory
  ps -p <pid>              # still there (state T)
  bowser list; bowser close --all   # empty; "no sessions to close"
  ```
  The process was then ended by its pid.
- A 0.5 daemon that still answers is not orphaned: `close` sends `shutdown`, and it exits (measured).
- Still reproduces on 0.7.0: yes.
- Cause:
  - `closeOne` swallows every connect failure (`src/commands/navigation.ts:191-198`).
  - With no pidfile, `pid` is null, so the check that the process ended is skipped
    (`src/commands/navigation.ts:206`).
  - It then deletes the directory and reports success (`:238-243`).
  - `connectOrSpawn` with `spawn: false` reports "no daemon" before it looks at whether the socket
    accepted (`src/daemon/client.ts:178`). A socket that accepted and never answered then looks the same
    as a stale socket.
- README says `close` "Fails if the browser process cannot be confirmed stopped".
- Who can hit it: only daemons from bowser 0.5 or older, since 0.6 writes a pidfile, and only when they
  are wedged. After F7, no new daemon runs without a pidfile.

**Decision: what `close` does with a silent daemon and no pidfile.** Ruled: option 1.
In both options, `close` tells a socket that accepted but never answered apart from one that refused
the connection. A refused connection still means a stale socket, and `close` removes it as today.
1. **(Recommended) Refuse and keep the session.** `close` fails with exit 2 and leaves the directory:
   `close: session '<name>' has no pidfile (a daemon from bowser 0.5 or older) and its daemon did not answer; find it with 'pgrep -fl -- "--daemon <name>"', end it, then run close again`.
   `close --all` reports it like any failed session (F31). This is the rule `closeLegacy` already
   applies to a legacy session with a socket and no pidfile (`src/commands/navigation.ts:260`).
   Cost: the user ends the process by hand. It is rare, and the message says how.
2. **Find the daemon and end it.** Scan `ps` for our daemon of this session (`looksLikeOurDaemon`).
   Keep only a process whose environment (`ps -wwE`) has this `HOME`, so that a daemon of the same
   name under another `HOME` is not touched; tests run with their own `HOME`. Then end it as for a
   recorded pid. Cost: two `ps` calls and a parser on a path used only for 0.5-era daemons. A 0.5
   daemon run from source is `bun …/src/daemon-main.ts <name>`, which `looksLikeOurDaemon` does not
   recognise, so it needs another pattern. Finding the process by its socket does not work: `lsof`
   lists the daemon's listening socket as plain `sock`, with no path (measured).

### F30: the daemon that loses the spawn race deletes the winner's pidfile

**Measured.**
- Repro from S4, on v0.6.0: two concurrent `snapshot`s on a new session, six trials. There was no
  pidfile in 4 of 6, with exactly one daemon running.
  ```sh
  for t in 1 2 3 4 5 6; do
    ( bowser -s=r2x snapshot & bowser -s=r2x snapshot & wait ) >/dev/null 2>&1
    cat ~/.bowser/sessions/r2x/pid || echo none; bowser -s=r2x close >/dev/null
  done
  ```
- Still reproduces on 0.7.0: **no**.
  - 3 concurrent `snapshot`s, 8 trials: 8 of 8 left one daemon and a pidfile naming it.
  - 2 and 5 concurrent `open`s, 6 trials each: 12 of 12 did the same.
  - `close` left no daemon in any trial.
- Why: P1's claim (F29). `startDaemon` claims the pidfile before anything else, and a loser returns
  before it writes one or registers the exit handler that removes it (`src/daemon/server.ts:348-354`).
- Existing tests already pin it: `tests/e2e-session-claim.test.ts:77` and `:191` assert that the pidfile
  names the one daemon.

**Behaviour.** None to add.

### F32: `list` takes about 1 s when any session is live

**Measured.**
- Repro:
  ```sh
  bowser -s=a open http://127.0.0.1:<port>/ ; time bowser list   # real 1.03 s (3 of 3 runs, 3 live sessions)
  bowser close --all ; time bowser list                          # real 0.02–0.04 s
  ```
- Still reproduces on 0.7.0: yes.
- Cause: `isLive` races `ping` against `Bun.sleep(LIVE_PROBE_MS)` and never cancels the sleep
  (`src/commands/navigation.ts:311-314`). The pending 1 s timer keeps the process alive after `list`
  has printed.
- The probe is also redundant. The connector it calls already pings with a bounded timer that it
  clears (`src/daemon/client.ts:172`, `withTimeout` in `src/serialize.ts:36`).

**Behaviour.**
1. `list` exits as soon as every probe has settled. With live sessions that answer, it takes about as
   long as with none (well under 0.2 s here).
2. A daemon that accepts and never answers still reads as not live after at most the probe bound
   (1 s), as now.

### F21: `BOWSER_OP_TIMEOUT_MS` is read only when the daemon starts; a `fill` timeout names `click`

**Measured.**
- Repro, on a page whose input is covered by a fixed full-page overlay, so a native click never
  lands:
  ```sh
  bowser -s=t1 open http://127.0.0.1:<port>/cover ; bowser -s=t1 snapshot   # textbox "Under" [ref=e2]
  BOWSER_OP_TIMEOUT_MS=3000 bowser -s=t1 click e2
  #   operation 'click' timed out after 30000ms   (30 s: the variable was ignored)
  BOWSER_OP_TIMEOUT_MS=3000 bowser -s=t2 open http://127.0.0.1:<port>/cover ; bowser -s=t2 snapshot
  bowser -s=t2 fill e2 hi
  #   operation 'click' timed out after 3000ms    (the command was fill)
  ```
- Still reproduces on 0.7.0: yes, both parts.
- Cause:
  - The daemon reads the variable once, in `startDaemon` (`src/daemon/server.ts:366`, `opTimeoutMs`
    at `:143`). A command that reaches a running daemon never sends its own value.
  - The timeout message names the daemon op (`src/daemon/server.ts:119`). `fill` sends `click` first,
    and `snapshot`, `eval`, `run-code` and `state-save` all send `evaluate`.
  - README (`README.md:244`) and SKILL.md (`skills/bowser/SKILL.md:177`) say nothing about when the
    value is read. SKILL.md says "Set it higher if a slow page causes timeout errors".

**Behaviour** (the op name; the budget is the open decision below).
1. A timeout names the command the user ran:
   `'<command>' timed out after <ms>ms (in its '<op>' step)`, for example
   `'fill' timed out after 3000ms (in its 'click' step)`. When the op has the command's own name,
   the part in parentheses is left out.
2. The queued form keeps its tail: `… (waiting for '<op>', which timed out and is still running; …)`.
3. The exit code is unchanged: 2.

**Decision: when `BOWSER_OP_TIMEOUT_MS` takes effect.** Ruled: option 1.
1. **(Recommended) Keep one budget per session, and document it.** README, SKILL.md and the variable's
   row say that the daemon reads it when the session starts, and that changing it takes `close` and
   `open`. The timeout message already prints the budget in force. Cost: no per-command override.
2. **A budget per request.** The CLI sends its `BOWSER_OP_TIMEOUT_MS` with each request, and `dispatch`
   uses it. Cost: it breaks the rule `dispatch` relies on, that every request ahead of a queued one had
   the same budget and so timed out first (`src/daemon/server.ts:88-89`). A short-budget request queued
   behind a long one would be told that the op ahead "timed out", while it is still inside its own
   budget. The queued message and the recovery grace would need rework, and the protocol a new field.
3. **Warn on a mismatch.** The daemon reports its budget in `state`, and a command whose variable
   differs prints a one-line warning on stderr. Cost: the warning repeats on every command in that
   session, and it adds a field that only this warning reads.

## Task 2: Actions

### F11: `press Tab` inserts `\t` instead of moving focus

**Measured.**
- Repro:
  ```sh
  bowser -s=a open http://127.0.0.1:<port>/form ; bowser -s=a snapshot   # textbox "A" [ref=e2], textbox "B" [ref=e3]
  bowser -s=a click e2 ; bowser -s=a press Tab
  bowser -s=a eval "JSON.stringify([document.activeElement.id, a.value, b.value])"   # ["a","\t",""]
  ```
  With focus on `<body>`, `press Tab` focuses nothing.
- Still reproduces on 0.7.0: yes.
- Cause: `press` hands the key name to `view.press` (`src/browser.ts:280`). Bun maps a named key to a
  WebKit editing command where one exists, and `Tab` becomes "insert tab". No `keydown` fires
  (measured: a capturing listener saw none).
- Measured directly on `Bun.WebView` (Bun 1.4.2):
  - `press("\t")`, the tab *character*, is sent as a raw key event. It moves focus forward: from `a`
    to `b`, and from `<body>` to the first field. Five presses from `<body>` walked
    `a → b → radio → enabled button → aria checkbox`, skipping disabled controls. The values stay
    empty. `keydown` fires with `key` `Tab`, `isTrusted` true, and `code` `KeyA`.
  - `press("Tab", { modifiers: ["Shift"] })` moves focus back (`b` → `a`).
- playwright-cli: `press Tab` moves focus to the next field and leaves the value alone
  (`["b",""]`, measured).

**Behaviour.**
1. `press Tab` moves focus to the next focusable element, as the browser's own Tab does. The focused
   field's value is unchanged.
2. From `<body>`, `press Tab` focuses the first focusable element.
3. A page `keydown` listener sees a trusted event with `key` `Tab`.
4. Every other key is unchanged.

### F20: actions on disabled controls, and `uncheck` of a radio, report success and do nothing

**Measured.**
- Repro, on a page with a disabled checkbox, a checked radio, a disabled button and an
  `aria-disabled="true"` `role=checkbox`:
  ```sh
  bowser -s=a check e5     # checkbox "DisabledBox" [disabled]: "checked e5", exit 0, stays unchecked
  bowser -s=a uncheck e7   # radio "Large" [checked]: "unchecked e7", exit 0, still checked
  bowser -s=a click e10    # button "DisBtn" [disabled]: "clicked e10", exit 0, its handler did not run
  bowser -s=a check e12    # checkbox "AriaDis" [disabled] (aria-disabled): "checked e12", and its click handler ran
  ```
  `click e10` returns in 0.13 s.
- Still reproduces on 0.7.0: yes, all four.
- Cause:
  - `check` and `uncheck` click the element when its `checked` differs, with no other test
    (`setCheckedScript`, `src/page-scripts.ts:713-719`). A disabled input ignores the click. A checked
    radio has `checked` true, so `uncheck` clicks it, and the click leaves it checked.
  - `click` is WebKit's native click on the live selector (`src/commands/interaction.ts:35`). It waits
    for the target to be hittable, not for it to be enabled.
- playwright-cli, measured on the same page:
  - `check e5`, `click e10` and `check e12` each fail after 5 s with `TimeoutError`, "element is not
    enabled". `aria-disabled` counts as disabled.
  - `uncheck e7` fails at once: `Cannot uncheck radio button. Radio buttons can only be unchecked by
    selecting another radio button in the same group.`
  - `uncheck` on an *unchecked* radio succeeds and does nothing.

**Behaviour.**
1. `click`, `check` and `uncheck` on a disabled element fail at once, with no wait:
   `ref 'eN' is disabled`, exit 1. Nothing is clicked.
2. "Disabled" is the rule the snapshot uses for `[disabled]`: a natively disabled control (a disabled
   `<fieldset>` included), or `aria-disabled="true"` on the element or an ancestor, for the roles that
   take it. It is checked on the live element, not on the saved ref.
3. `uncheck` on a checked radio (`input[type=radio]`, or role `radio` or `menuitemradio`) fails at once:
   `ref 'eN' is a radio button; select another option in its group to uncheck it`, exit 1. The radio
   stays checked.
4. `uncheck` on an unchecked radio succeeds and does nothing, as in playwright-cli.
5. No extra daemon round trip. The disabled check rides the ref resolution the command already runs
   (`resolveRefScript`), and the radio check rides `setCheckedScript`.
6. The `cli.ts` exit-code regex gains both messages.

## Task 3: Output fidelity

### F16: an SVG `<title>` is not used as the accessible name

**Measured.**
- Repro page:
  ```html
  <a href="/"><svg role="img"><title>Logo</title>…</svg></a>
  <button><svg><title>Close</title>…</svg></button>
  <svg role="img" aria-label="Lab"><title>T</title></svg>
  ```
- bowser: `link [ref=e2]` with `img [ref=e3]`, `button [ref=e5]` with `img [ref=e6]`, and `img "Lab"`.
- playwright-cli (WebKit): `link "Logo"` with `img "Logo"`, `button "Close"` with `img "Close"`, and
  `img "Lab"`. `aria-label` wins over `<title>` in both tools.
- Seen for real on MDN: the header logo `<svg role="img"><title>MDN</title>` gave an unnamed link.
- Still reproduces on 0.7.0: yes.
- Cause: the walker's name computation (`textAlt` in `SNAPSHOT_SCRIPT`) has native-name branches for
  `IMG`/`AREA` (`src/page-scripts.ts:349`) and none for SVG.
- playwright's rule, in `getTextAlternativeInternal`, after the `AREA` branch: for an `<svg>` element or
  any element inside an SVG, the name is its first child `<title>` (an SVG `<title>`), computed as
  embedded text.

**Behaviour.**
1. An `<svg>`, or any element inside one, takes its name from its first child SVG `<title>`. This comes
   at the same step as in playwright: after `aria-labelledby` and `aria-label`, and before the name
   from content and the `title` attribute.
2. The name flows into a parent that is named by its content: a button or link whose only content is
   such an SVG gets the title as its name.
3. An `aria-label` or `aria-labelledby` on the SVG still wins.
4. The change is on the walker's side (semantic). The renderer is untouched.

### F17: `screenshot` covers only the viewport, but the docs say "Full-page"

**Measured.**
- Repro:
  ```sh
  bowser -s=a goto http://127.0.0.1:<port>/big     # one 3000×5000 CSS px div
  bowser -s=a screenshot --filename=big.png        # 2560×1600 PNG: the 1280×800 viewport at 2x
  ```
- Still reproduces on 0.7.0: yes.
- The docs say full page:
  - SKILL.md: "Full-page screenshot (PNG)" (`skills/bowser/SKILL.md:47`) and "Full-page only" (`:174`);
  - README: `README.md:47` and `:178`;
  - the command's summary: "Save a full-page PNG screenshot" (`src/commands/snapshot.ts:98`);
  - code comments: `src/commands/snapshot.ts:69`, `src/browser.ts:87` and `:285`.
- `Bun.WebView.screenshot()` is documented as "a screenshot of the current viewport", and it takes no
  full-page option (`bun-types`).
- playwright-cli: the default is the viewport (1280×720 here). `--full-page` captures the whole page
  (3000×5000).

**Behaviour.**
1. `screenshot` keeps capturing the viewport, which is playwright-cli's default.
2. README, SKILL.md, the command's summary (and so `--help` and the MCP tool description) and the code
   comments say "viewport", not "full page". The summary reads: "Save a PNG screenshot of the viewport".

### F18: `run-code` does not match playwright-cli; `async page => …` and the documented IIFE print nothing

**Measured.**
- Repro:
  ```sh
  bowser run-code "async page => { return await page.title() }"   # empty output, exit 0
  bowser run-code "(() => { return 5 })()"                         # empty output, exit 0
  bowser run-code "await new Promise(r => setTimeout(r, 100)); return 1"
  #   SyntaxError: Unexpected keyword 'new', exit 2
  bowser run-code "return document.title"                          # Big
  ```
- Still reproduces on 0.7.0: yes, all three.
- Cause:
  - `runCodeScript` wraps the text as the body of a plain function: `(() => { <code> })()`
    (`src/page-scripts.ts:801-803`).
  - A function expression or an IIFE is then a statement whose value is dropped, so the result is
    `undefined`, printed as an empty line.
  - The wrapper is not `async`, so `await` is a syntax error.
  - README (`README.md:195`) and SKILL.md (`skills/bowser/SKILL.md:64`) tell the user to "wrap in an
    IIFE", which yields nothing.
- playwright-cli: `run-code` takes a function that it calls, in Node, with a Playwright `page`
  ("a javascript function containing playwright code to execute. it will be invoked with a single
  argument, page"). Measured:
  - `async page => { return await page.title() }` prints the title;
  - `return document.title` is a `SyntaxError`;
  - `() => document.title` is `ReferenceError: document is not defined`.
- The two commands share a name, but not what they run. bowser runs page JavaScript, and has no
  Playwright `page` to hand over.

**Decision: what `run-code` does with playwright-cli's function form.** Ruled: option 1.
1. **(Recommended) Page JavaScript, made honest.**
   - Code that parses as one expression is evaluated as an expression, and its value is the result:
     `(() => { return 5 })()` prints `5`.
   - Any other code is the body of an **async** function: `return` gives the result, and `await`
     works.
   - A result that is a function, such as `async page => …`, fails with exit 1:
     `run-code runs JavaScript in the page and has no Playwright 'page'; write statements and use return`.
   - README and SKILL.md drop "wrap in an IIFE", and say that `run-code` runs in the page, unlike
     playwright-cli's.

   Cost: playwright-cli snippets still do not run, but they fail loudly, and the documented forms work.
2. **Call the function with a small `page` object in the page**, for example `title()`, `url()` and
   `evaluate(fn, arg)`. Cost: a partial Playwright API that fails on the first method it lacks (`goto`,
   `locator`, waits). A user cannot tell from the snippet which methods exist, and the list keeps
   growing.
3. **Docs only.** Drop the IIFE advice and describe the wrapper. Cost: the silent empty output stays
   for both forms.

### F34: a crash of the WebContent process goes unreported

**Measured.**
- The crash was made by `kill -9` of the session's own WebContent process. It was identified as the one
  new `com.apple.WebKit.WebContent` pid after `open`, and its start time was checked. No other process
  was touched. There is no crash URL for WebKit that a page can load.
  ```sh
  pgrep -f com.apple.WebKit.WebContent | sort > before
  bowser -s=wk open http://127.0.0.1:<port>/form
  pgrep -f com.apple.WebKit.WebContent | sort > after ; W=$(comm -13 before after)
  bowser -s=wk eval "(window.mark=7,1)" ; kill -9 $W ; sleep 1.5
  bowser -s=wk eval "String(window.mark)"   # undefined: the page was reloaded, nothing reported, exit 0
  # kill the relaunched WebContent (the new pid) once more:
  bowser -s=wk eval "location.href"         # bowser: JavaScript execution returned a result of an unsupported type   exit 2
  bowser -s=wk snapshot                     # the same
  bowser -s=wk click e2                     # the same
  bowser list                               # wk is listed
  bowser -s=wk reload                       # reloaded http://…/form; eval works again
  ```
- Still reproduces on 0.7.0: yes, both phases.
- Measured on `Bun.WebView` directly (Bun 1.4.2):
  - After the first crash the engine relaunches the process and reloads the page. `onNavigated` fires
    again with the same URL, as it does for a page's own `location.reload()`, so nothing marks it as a
    crash.
  - After the second crash nothing reloads:
    - every `evaluate`, including `1+1`, fails with `JavaScript execution returned a result of an
      unsupported type`;
    - `click` fails with the same message;
    - `screenshot` fails with `An unknown error occurred`;
    - `reload()` recovers.
  - That message does not come from ordinary page values. `10n`, `window`, `Symbol()`, a `Map`, and a
    throw each give their own error or a value, because `evaluate` serializes page-side with
    `JSON.stringify`.
- Cause: the daemon passes the engine's message through (`src/daemon/server.ts:265-267`), and `Bun.WebView`
  has no crash event.
- playwright-cli: Playwright marks a crashed page, and later calls fail with a "crashed" error. This was
  not measured here: there is no crash trigger to use through `playwright-cli`.

**Behaviour.**
1. When a page op fails with the engine's dead-page message (`JavaScript execution returned a result of
   an unsupported type`), the error reads:
   `the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'`. It exits 2,
   a runtime error.
2. The page is not reloaded automatically. `reload`, `goto` and `open <url>` recover it, as they do now.
3. The first crash, which the engine recovers by reloading the page, stays unreported, because nothing
   tells it apart from a page reloading itself. SKILL.md says so: after such a reload, page state is
   gone and old refs fail with `not found in the current page snapshot`.

## Task 4: Distribution

### F7: a downloaded release binary hangs under Gatekeeper

**Measured.**
- Repro from S1, on v0.6.0: a copy of the release binary with `com.apple.quarantine` set, as a browser
  download sets it, hung on `--help` with no output until killed after 20 s. The attribute was set
  with `xattr -w com.apple.quarantine "0083;<hex time>;Safari;"`. Removing the attribute afterwards did
  not make that copy run: a Gatekeeper dialog may have been pending. README's Install section points
  at the Releases page and gives no workaround.
- Still reproduces on 0.7.0: the cause does. The v0.7.0 `bowser-macos-arm64` asset has
  `Signature=adhoc`, flags `adhoc,linker-signed`, no Team ID, and `spctl -a -vv` says `rejected`.
  The hang itself was not rerun: in S1 it may have left a Gatekeeper dialog on the owner's screen.
- **Ruled by the owner:** release binaries are removed. bowser is distributed only through npm, and
  from source.

**What exists only for the binary** (all removed):
- `.github/workflows/release.yml`:
  - the `build` job (the two `--compile` targets and the `--help` smoke test);
  - the artifact upload and download, and `SHA256SUMS.txt`;
  - the `files:` list of the release step;
  - the "re-publishing binaries" comment.
- `.github/workflows/test.yml`: the `build single binary` job, and the `E2E - compiled binary daemon +
  screenshot` step, which is replaced (below).
- `src/cli.ts:53-74`: the hidden `--daemon` entry.
- `src/daemon/client.ts:235-245`: the `/$bunfs/` detection and the `[execPath, "--daemon", session]`
  command. The daemon is always `[process.execPath, <dir>/main.ts, session]`.
- The comments that justify the removed code:
  - `src/daemon/client.ts:154` ("compiled binary's --daemon");
  - `src/mcp.ts:80-82` and `:334` ("deadlocks in the compiled binary"). The `run` injection itself
    stays: whether a dynamic import of `cli.ts` also deadlocks from source was not measured.
- `package.json`: the `build` script.
- `.gitignore`: `dist/`.
- `README.md`:
  - the "Single static binary" bullet (`:14`);
  - the Releases paragraph (`:33-34`);
  - the "Build a single binary" section (`:263-275`).

**What stays:**
- `proc.unref()` in `spawnDaemon`. Measured: with it removed, `bun src/cli.ts -s=nu open <url>` printed
  `opened …` and then hung until killed at 20 s (exit 142). With it, the command returned at once.
- `looksLikeOurDaemon`'s compiled form (`bowser --daemon <session>`, `src/daemon/pidfile.ts:41`), its
  tests (`tests/commands.test.ts:672-676`), and the session-name rule against `--daemon victim`
  (`src/state.ts:62`). Daemons started by a 0.6 or 0.7 binary may still be running after the switch,
  and `close` must still recognise them.
- `main.ts` resolving `false` → `process.exit(0)`, and no exit after `startDaemon` otherwise.

**Behaviour.**
1. A `v*` tag makes a GitHub Release with generated notes and no assets, and publishes to npm. The
   npm job is unchanged: trusted publishing (OIDC), the npm ≥ 11.5.1 check, the tag-version check, and
   the skip when the version is already published.
2. The daemon is always spawned as `bun <package>/src/daemon/main.ts <session>`. Measured from an
   `npm pack` tarball installed with `npm i -g --prefix <tmp>`:
   - the `bin` symlink runs `src/cli.ts` through its `#!/usr/bin/env bun` shebang;
   - the daemon ran as `bun <tmp>/lib/node_modules/@drakulavich/bowser-cli/src/daemon/main.ts <session>`,
     which `looksLikeOurDaemon` recognises;
   - `open`, `screenshot`, `close`, and `open --persistent` then `close` (the profile kept) all worked.
3. CI keeps a check of the installed CLI, now on the npm shape. The `e2e-webkit` job runs `npm pack`,
   installs the tarball with `npm i -g --prefix "$RUNNER_TEMP/npm"`, and runs that prefix's
   `bin/bowser` through the same `open` / `screenshot` / `close` and `--persistent` checks, each bounded
   by the perl `alarm`. This is more faithful than `bun src/cli.ts`, because it also runs what a user
   installs: the `files` list (a source file left out of the package fails here and nowhere else), the
   `bin` mapping, the shebang, and the installed directory layout the daemon path is computed from.
4. **Bun guard.** Before it spawns a daemon, `connectOrSpawn` checks the running Bun against
   `engines.bun` in `package.json` (`Bun.semver.satisfies`). On an older Bun, or one without
   `Bun.WebView`, it fails at once with `bowser requires Bun >=1.4.2 (found <version>)`, exit 1.
   - The floor is 1.4.2, after PR #53. It is read from `engines.bun`, so the message follows the floor.
   - The check sits next to the macOS check, because the daemon would otherwise die unseen and the user
     would get only `did not start in time`.
   - This is issue #51's smell S2. Cost: one import of `package.json` and one comparison, only on the
     spawn path.
   - Why it is needed: npm does not enforce `engines.bun`, so an npm install runs on whatever Bun the
     user has.
5. README:
   - The Why bullet becomes "Bun-native: runs on Bun, no Node or Playwright install".
   - Install gives `npm install -g @drakulavich/bowser-cli` (and from source), and says Bun ≥ 1.4.2
     must be on `PATH`. The npm package runs `src/cli.ts` with the `bun` it finds there.
   - A migration line for binary users: run `bowser close --all` with the old binary, delete it, then
     `npm i -g @drakulavich/bowser-cli`.
   - The Releases paragraph and the "Build a single binary" section are removed.
6. CHANGELOG: a **BREAKING** entry. Release binaries are no longer built or attached, bowser installs
   through npm or from source, and the migration line above.
7. CLAUDE.md: the "Checking a change" line about the compiled binary is removed. The e2e test in
   Acceptance (a spawned `bun src/cli.ts open` that must exit) covers `proc.unref()`, and the npm-shape
   CI step covers the install. This follows the file's own rule: a line goes once a test makes it
   unnecessary.

## Acceptance (public seams only)

1. **Unit tests** cover:
   - F2: a fake daemon on the session socket that answers `ping` with `"pong"`, then with another
     version:
     - `snapshot`, and `open` with a URL, exit 1 with the version message and send no other request;
     - `close` sends `shutdown`;
     - `list` lists the session;
     - a daemon with the client's version is used as now;
   - F3, per the decision: a socket that accepts and never answers, with no pidfile. `close` exits 2 and
     keeps the directory (option 1). A socket with no listener is still removed with success;
   - F32: `bun src/cli.ts list`, spawned with a `HOME` holding one answering fake daemon, exits in under
     0.5 s. A fake that never answers is not listed, and the command still exits within about 1 s;
   - F21: a daemon op that overruns a small budget through `fill` prints
     `'fill' timed out after <ms>ms (in its 'click' step)`. `click` prints no step;
   - F34: through `createHandler` with a fake browser whose `evaluate` throws the dead-page message, the
     reply carries the crash message. Other errors pass through unchanged;
   - F7: `connectOrSpawn` with a faked Bun version below the floor fails with `bowser requires Bun` and
     spawns nothing (the platform check already takes a fake the same way).
2. **WebKit e2e** covers:
   - F11: `press Tab` from a text field focuses the next field and leaves the value empty; from `<body>`
     it focuses the first field;
   - F20:
     - `click` on a disabled button, and `check` on a disabled and on an `aria-disabled` checkbox, exit 1
       with nothing changed and no handler run;
     - `uncheck` on a checked radio exits 1, and it stays checked;
     - `uncheck` on an unchecked radio exits 0;
   - F16: a new fixture with the SVG cases above, and its golden captured with `playwright-cli` 0.1.13
     (Edge), under the golden rules in `tests/e2e-snapshot.test.ts`. The fixture leaves out an
     `aria-hidden` SVG: the engines differ there, which is out of scope;
   - F18, per the decision: `(() => { return 5 })()` prints `5`; `await …; return 1` prints `1`;
     `async page => …` exits 1;
   - F34: kill this session's own WebContent process twice (found by the pid diff; the test skips if the
     diff is not exactly one pid). The next `eval` exits 2 with the crash message, and `reload` recovers;
   - F7 (retires the CLAUDE.md line): `bun src/cli.ts open <data: URL>` spawned as a process exits within
     a bound, which fails if `proc.unref()` is removed; then `close`.
3. **CI:** the npm-shape step in `test.yml` (F7 Behaviour 3). `release.yml` has no binary job. A manual
   `gh workflow run release.yml -f tag=…` still works.
4. **Mutation checks:** every fix, when removed, fails at least one test. F17 is docs only and is
   exempt. F30 is already pinned by `tests/e2e-session-claim.test.ts`.
5. **Docs:**
   - README and SKILL.md:
     - `screenshot` is viewport-only (F17);
     - `run-code` as decided (F18);
     - `press Tab` moves focus (F11);
     - disabled controls and radio `uncheck` fail (F20);
     - the crash message and the unreported first crash (F34);
     - `BOWSER_OP_TIMEOUT_MS` as decided (F21);
     - the version check and "close before you upgrade" (F2);
     - npm-only install with Bun ≥ 1.4.2 (F7);
   - `tests/docs-drift.test.ts` still passes: no command is added or renamed;
   - CLAUDE.md: the compiled-binary line goes (F7);
   - CHANGELOG Unreleased, with F7 marked BREAKING.

## Out of scope

- F19: modifier chords and unknown keys in `press`. Noted for it: `Bun.WebView` sends `Shift+Tab`
  correctly as `press("Tab", { modifiers: ["Shift"] })` (measured).
- The `code` of the Tab `keydown` is `KeyA`, not `Tab`: Bun sends the raw character. `key` is right.
- `select` on a disabled `<select>`. A `check` whose click leaves the state unchanged (playwright
  reports "did not change its state").
- A `--full-page` flag for `screenshot`, and the 2x pixel density (playwright-cli's viewport shot is
  1x). `Bun.WebView.screenshot()` has no full-page option.
- SVG `xlink:title` on an `<a>` inside an SVG. playwright-cli on WebKit lists an `aria-hidden` SVG as
  `img` (the GitHub octicon difference from S2).
- A Playwright `page` object for `run-code`, and `run-code --filename`.
- Detecting the first WebContent crash. `list` showing a crashed page's session as live. `screenshot`'s
  `An unknown error occurred` after a crash.
- Restarting an old daemon automatically on upgrade. An MCP server started by an older version. A
  `--version` flag (S1's question; F2's version would make it cheap).
- Code signing and notarization (ruled out by the removal of binaries). A note that the 0.5
  `~/.bowser/chromium` cache can be deleted.
