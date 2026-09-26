# Spec: P0 from the v0.6.0 exploratory testing: a session never hangs, never lies about the page

**Status:** approved 2026-09-26. The owner's words: "Начинай с P0 в один PR" (start with P0, in one PR).
**Origin:** the P0 tier of the findings page (https://claude.ai/artifact/4qkJGdsLBBWoCcK1aMARgf). The
repros are in the session sheets `S1.md`, `S2.md`, `S4.md` and `S5.md` from the testing run. They are
restated below so this spec stands alone.

## Findings and required behaviour

### F9: a timed-out op holds the queue and wedges the session

**Measured.**
- `withTimeout` rejects the reply at the budget, but `createSerializer` (`src/serialize.ts`) runs the
  next op only after the timed-out one settles. The budget does not count the time a request spends
  queued.
- With `BOWSER_OP_TIMEOUT_MS=2000`, a 9 s `eval` times out at 2 s, and the next `eval 1` takes 6.98 s.
- A navigation that never settles, `goto localhost:<port>` (no scheme, see F15), or `snapshot` of a page
  with 60k paragraphs wedges the session until `close`.

**Behaviour.**
1. Each request's budget runs from the moment the daemon receives it and includes queue time. A request
   still queued at its deadline fails with
   `operation '<op>' timed out after <ms>ms (waiting for '<prev op>', which timed out and is still running; run 'bowser close' if the session stays stuck)`.
   It exits 2 like any timeout.
2. After an op times out, the daemon tries once to free the WebView:
   - First measure on WebKit what actually interrupts a stuck `evaluate` and a navigation that never
     settles (for example `view.stop`, a navigate to `about:blank`, or a reload), and use what works.
   - If recovery succeeds, the session keeps working: the next command runs normally on whatever page
     the recovery left.
   - If nothing interrupts it, requests fail fast as in item 1. The session never hangs a command
     beyond its budget.
3. `close` always works, as it does today (the urgent lane).

### F36: one slow MCP call freezes the whole MCP server

**Measured.** `src/mcp.ts` handles stdin lines one at a time, awaiting each (`await handleMcpLine`).
While a call to session A runs, `ping` and calls to session B wait; they answered after 35.6 s. The
server ignores `notifications/cancelled`.

**Behaviour.**
1. `ping`, `initialize`, `tools/list` and notifications are answered at once, even while calls are
   running.
2. `tools/call` requests for different sessions run concurrently. Calls for the same session keep their
   arrival order; the daemon serializes them anyway.
3. `notifications/cancelled` for a running call stops the server from waiting on it. Per the MCP spec,
   the server sends no response for a cancelled request. The daemon-side op is not un-run: document
   that.
4. stdout stays pure JSON-RPC, and responses may arrive out of order (JSON-RPC allows that).

### F8: `click` and `fill` cannot reach an element below the fold

**Measured.** On a link 2500 px down the page, `click e3` times out after 30 s (exit 2). `check`,
`select` and `hover` work. `playwright-cli` scrolls the element into view and clicks.

**Behaviour.** Every ref action that uses a native pointer or keyboard action on an element (`click`,
`dblclick` if present, `fill`, `type` after a click, `hover`, `check`/`uncheck` if native) scrolls the
element into view first. Use `scrollIntoView({block: "center", inline: "center"})` inside the page
script that resolves the ref, so it costs no extra round trip. After that, the far link in the repro
clicks in well under a second.

### F10: `click` returns before a slow navigation commits

**Measured.** A click on a link to a page whose server answers after 3 s returns in 0.12 s. `snapshot`
then shows the old page and its old refs. On HN, `click "new"` followed by `go-back` ended up on
`/newest`.

**Behaviour.**
1. A navigation that a navigating action (`click`, `press`, `back`, `forward`, `reload`) starts is
   awaited until it commits and settles, up to the existing `settleMs`, even when the server is slow to
   answer.
2. The 100 ms grace window detects that a navigation *started*. First measure how a provisional
   (not yet committed) navigation shows on WebKit (`view.loading`, `onNavigated`, anything else), then
   pick the signal that is visible within the grace window for a slow server.
3. After the repro click, `snapshot` shows the new page. An action that starts no navigation still
   costs only the grace window.

### F1: `<cmd> --help` runs the command

**Measured.** `bowser -s=t1 close --help` prints `closed session 't1'` and deletes the session.
`open --help` opens one, and `bowser -h close` also closes. `playwright-cli` prints per-command help.

**Behaviour.**
1. When `-h`/`--help` appears anywhere before `--`, the command is not run. bowser prints that command's
   help (usage line, summary, positionals, flags, all from the registry) and exits 0.
2. With no command, it prints the general help, as today.
3. `bowser mcp --help` prints help and does not start the server.
4. After `--`, `--help` is data (a positional), as the end-of-options rule already says.

## Acceptance (public seams only)

1. **Unit tests** cover:
   - F9 item 1: the queue-time budget and the message, with a fake handler that never settles;
   - F36 items 1–4: `ping` answered while a call to another session hangs, per-session order, and
     cancellation, through the MCP server's public entry with a fake daemon client;
   - F1: per-command help for every command in the registry, and that no daemon request is made.
2. **WebKit e2e** covers:
   - F8: click on a far link, and fill on a far input;
   - F10: a click on a link to a 3 s page, after which `snapshot` shows the new page;
   - F9: a stuck `eval` followed by `eval 1`, which either works after recovery or fails fast within
     its budget, and `close` works;
   - F9: `goto` a never-settling URL, then a command bounded by its budget.
3. **Mutation checks:** every fix, when removed, fails at least one test.
4. **Docs:**
   - CLAUDE.md gotchas: the serializer and timeout gotcha, the `nav.act` gotcha, per-command help, and
     MCP concurrency;
   - README and SKILL.md where the behaviour is described;
   - CHANGELOG Unreleased.

## Out of scope

F15 (normalising a URL without a scheme) and F4 (extra arguments), which are P1. Here F15 only has to
stop wedging the session, which F9 covers. Cancelling a daemon-side op beyond what recovery does.
