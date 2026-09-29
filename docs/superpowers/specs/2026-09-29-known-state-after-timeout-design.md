# A known state after a timeout (#78)

**Issue:** #78 (ET-09, ET-10, ET-12 and ET-15 from the 2026-09-28 exploratory campaign, `docs/superpowers/exploratory-testing/2026-09-28-session-log.md`).
**Status:** approved in conversation 2026-09-29.

## Goal

After any timeout, the next command either works on a settled page or fails at once with a clear message that tells the agent what to do. A timeout reply says whether the action reached the page. bowser never reports success for a page it is not on, and a command never waits out its whole budget behind a session that cannot recover.

bowser does not rebuild the WebView to recover: a session without `--persistent` would lose its cookies and localStorage. A session that cannot recover says so and asks for `bowser close`.

## Findings

- **ET-09.** After a timed-out `click` whose navigation went to a server that never answers, the recovery reload releases the lane before it lands. The next command runs on the page being replaced. It reports the old page as success, fails with a misleading error, or (2 of 5 runs) wedges the session until `close`.
  Cause: the reload cancels the stuck navigation, which reports -999, and `interrupt()`'s `settle` counts that failure as the landing (`src/browser.ts`, `navigationWatch().interrupt`).
- **ET-10.** A submit that posts to a server that never answers returns `clicked` after the 10 s navigation cap. The next `fill` then hangs its whole budget in its `click` step, and its text is never typed. Cause: not known.
- **ET-12.** An `eval` of a promise the page keeps reachable is not freed by the recovery reload. Two of three sessions stayed wedged until `close`, one of them for 12 min.
- **ET-15.** A timeout during the navigation wait does not say that the action was delivered. A `click` on a link to a page served after 3 s, with a 3 s budget, answers `'click' timed out` although the page loaded, so a retry can act twice. Each step of a command also gets the full budget, so `fill` with a 3 s budget answered after 4 973 ms.

## Design

### 1. Recovery waits for its own reload (ET-09)

`interrupt()` waits for the reload to land: a successful landing (`arrived` changes), or a second landing after the cancelled navigation's failure. It no longer stops at the first landing of any kind. The cap stays `settleMs`.

`interrupt()` resolves with `true` when the view is free and `false` when it is not: the timed-out op had not settled by the end of the wait. `Browser.interrupt(): Promise<boolean>`.

### 2. A stuck session fails fast (ET-09, ET-12)

When recovery ends and the timed-out op is still running, the daemon marks the session stuck. While it is stuck, every non-urgent request is answered at once, without waiting at the gate or the serializer:

`session is stuck: '<cmd>' is still running after a reload; run 'bowser close'`

with exit 2. The mark clears when that op settles, and the session then works again. Urgent ops (`ping`, `shutdown`) are unaffected, so `close` always works.

### 3. A timeout says whether the action was delivered (ET-15)

For ops that act through `nav.act` (the `ACTS` and navigating ops), the Browser reports the phase of the running action: `acting` until the action's native call returns, then `awaiting-navigation`. A timeout in `awaiting-navigation` answers:

`'<cmd>' timed out after <ms>ms waiting for the page it opened; the <cmd> was delivered, check the page before retrying`

A timeout in any other phase keeps today's message.

### 4. The budget is per command (ET-15)

The client sends each request the time left of the command's budget, in a new optional field `budgetMs` on `DaemonRequest`. The daemon times the request with `min(budgetMs, BOWSER_OP_TIMEOUT_MS)`. A command's total time is then bounded by its budget, plus the time it takes to connect. A request without `budgetMs` keeps today's behaviour. The client and the daemon are one version, since the daemon refuses a client of another version (F2), so no compatibility shim is needed.

### 5. ET-10 starts with a measurement

The first implementation task measures, on WebKit (Bun 1.4.2), what holds the native `click` of a later command while a POST to a server that never answers is pending: `view.loading`, the navigation's provisional state, or something else. What the fix does depends on the result:

- **The pending navigation is the cause.** An action that starts while the navigation a previous command started is still pending waits for it within its own budget. If the navigation is still pending when the budget ends, the action fails with `page is still loading <url>; retry later, or run 'bowser close'`, exit 2.
- **The cause is something else.** Implementation stops, and the finding goes back to the owner with the data before this part of the design changes.

## Definition of done

1. **ET-09.** With a link to a server that never answers and `BOWSER_OP_TIMEOUT_MS=3000`, `click` times out. The next `eval location.href`, over 5 runs, either reports the reloaded page's URL (exit 0) or fails with the stuck message (exit 2). It never reports the pre-reload page as success, and it never takes longer than its own budget.
2. **ET-12.** After an `eval` of a reachable promise that never settles times out, and once recovery has ended, every later command fails within 1 s with the stuck message. A command sent during the recovery grace waits for it, within its budget. When WebKit frees the evaluate (about 4 s after the reload, measured), the session works again without `close`. The page cannot resolve the promise itself, because the reload replaced its document.
3. **ET-10.** The measurement is recorded in the plan's task report. After a submit to a server that never answers, the next `fill` either types its text, or fails within its budget with `page is still loading …`. It never hangs past its budget and never exits 0 without typing.
4. **ET-15, message.** `click` on a link to a page served after 3 s with a 3 s budget fails with `… waiting for the page it opened; the click was delivered …`.
5. **ET-15, budget.** `fill` with `BOWSER_OP_TIMEOUT_MS=3000` against a page whose steps are slow answers, success or failure, within 3.5 s.
6. **Close.** `close` succeeds within 2 s from every state above.
7. **No regressions.** The F9 and #67 hang tests (`tests/e2e-hangs.test.ts`), the #77 gate tests and the MCP tests pass. Where a stuck message now replaces the F9 queue message, the test is updated and the change is named in the PR.
8. **Tests.** Every item above has a test: unit tests for the stuck mark, the phase message and the budget arithmetic; e2e tests for items 1–6 with the S2 fixtures. Each was seen failing before its fix.
9. **Checks.** `bun run check` passes, and so does `BOWSER_E2E=1 bun test`. CI is green.
10. **Docs.** README and SKILL.md describe the stuck message and the per-command budget, and CHANGELOG `[Unreleased]` has an entry for each.
11. **Review and issue.** A Codex review ends with no open Critical or Required finding, and #78 is closed by the PR.

## Out of scope

- Rebuilding the WebView to recover.
- A native `stop()` for a navigation: `Bun.WebView` has none.
