# Known State After a Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any timeout, the next command works on a settled page or fails at once with a clear message; timeouts say whether the action reached the page; a command's budget covers the whole command (#78).

**Architecture:**
- `Browser.interrupt()` waits for its own reload and reports whether the view is free.
- `dispatch` marks the session stuck when a timed-out op outlives recovery, and answers every request fast until that op settles.
- `nav.act` exposes the action's phase for the timeout message.
- The client sends each request the time left of its command's budget, and the daemon times the request with the smaller budget.
- ET-10 begins with a measurement.

**Tech Stack:** Bun, TypeScript, `bun:test`, Bun.WebView (WebKit, macOS).

**Spec:** `docs/superpowers/specs/2026-09-29-known-state-after-timeout-design.md`. Its Definition of done is the acceptance list.

## Global Constraints

- **Stuck message**, exactly: `` `session is stuck: '${op}' is still running after a reload; run 'bowser close'` ``, exit 2.
- **Delivered message**, exactly: `` `'${cmd}' timed out after ${ms}ms waiting for the page it opened; the ${cmd} was delivered, check the page before retrying` ``.
- **ET-10 message**, if Task 1 confirms the pending navigation: `` `page is still loading ${url}; run 'bowser goto' to leave it or retry later` ``, exit 2.
- **`budgetMs`** is optional on `DaemonRequest`. The daemon uses `min(budgetMs, BOWSER_OP_TIMEOUT_MS)`, where 0 means off. A request without it behaves as today.
- **Urgent ops** (`ping`, `shutdown`) are never answered with the stuck message, and never wait. `close` always works.
- **No WebView rebuild**, and no `view.stop` (none exists).
- `bun run check` and `BOWSER_E2E=1 bun test` pass. Comments only where a reader would otherwise break something silently.

## Review Focus

- **A stuck op that settles while a request is already queued.** The queued request runs normally; it is not answered "stuck" after the mark cleared. Test in Task 3.
- **Two timeouts in a row.** A second timed-out op while the session is already stuck does not start a second recovery. Test in Task 3.
- **`budgetMs` of 0 or negative.** The time is already spent: the request fails at once with the normal timeout message, and is never run with no limit. Test in Task 5.
- **`BOWSER_OP_TIMEOUT_MS=0` (budgets off).** No stuck mark is ever set (no timeouts happen), and `budgetMs` is not sent. Tests in Tasks 3 and 5.
- **The phase after an action that throws.** The phase resets, so a later timeout does not claim a delivered action. Test in Task 4.

---

### Task 1: Measure ET-10

**Files:**
- Create: `scratch` only, under the scratchpad; nothing is committed except the report.
- Report: `.superpowers/sdd/2026-09-29-known-state/task-1-report.md`

**Interfaces:**
- Produces: a verdict, `pending-navigation` or `other`, with evidence. Task 6 consumes it.

- [ ] **Step 1: Reproduce ET-10** with a fixture server whose POST never answers: `fill`, `click` Submit (returns `clicked` after about 10 s), then `fill` another field (hangs in its `click` step). Use the S2 fixture in `scratchpad/s2/` if it is present.
- [ ] **Step 2: Measure during the hang**, from a bare `Bun.WebView` script: `view.loading`, `view.url`, `NAV_COUNT`, whether `view.evaluate("1")` answers, and whether `view.click` of another element resolves. Also check whether the click hangs if the pending navigation is first cancelled by a script `location.replace(location.href)`.
- [ ] **Step 3: Write the report** with the measured numbers and the verdict. `pending-navigation` means the click resolves once the pending navigation ends or is cancelled.

### Task 2: interrupt waits for its own reload

**Files:**
- Modify: `src/browser.ts`: `Browser.interrupt` (line ~110) and `navigationWatch().interrupt` (~396)
- Test: `tests/browser.test.ts` (the `wrapView interrupt` describe, ~491)

**Interfaces:**
- Produces: `interrupt(): Promise<boolean>`. It resolves `true` when a successful landing (`arrived` changed) or a second landing happened within `settleMs`. It resolves `false` when the call was refused, nothing landed, or only the cancelled navigation's failure landed.

- [ ] **Step 1: Write the failing tests** with a fake view:
  - `interrupt waits past the cancelled navigation's failure`: `reload()` makes `onNavigationFailed` fire at once (the -999), then `onNavigated` 100 ms later. `interrupt()` resolves after the `onNavigated` and returns `true`.
  - `interrupt returns false when nothing lands`: settleMs 50, no callbacks, so the result is `false`.
  - `interrupt returns false when only the failure lands`.
- [ ] **Step 2:** Run `bun test tests/browser.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement it. `settle` waits on `arrived` or on a second `landed`. The initial-document branches return `true` when they left it.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5:** Commit: "Recovery waits for its own reload, and says whether it freed the view (#78)".

### Task 3: A stuck session fails fast

**Files:**
- Modify: `src/daemon/server.ts`: `Lane.recover` becomes `() => Promise<boolean>`; `dispatch`; the `startDaemon` wiring
- Test: `tests/daemon-handler.test.ts`

**Interfaces:**
- Consumes: `interrupt(): Promise<boolean>` from Task 2.
- Produces: a per-daemon `stuck: { op: string } | undefined` that `dispatch` reads.
  - It is set when a timed-out op is still running after `recover()` resolves; its truth value alone is not enough.
  - It is cleared when that op settles.
  - A non-urgent request that arrives, or reaches the gate, while `stuck` is set is answered at once with the stuck message, and it enters neither the gate nor the serializer.

- [ ] **Step 1: Write the failing tests:**
  - `a request after an unrecovered timeout is answered stuck at once`: the handler never settles; recover resolves `false`. The next `evaluate` is answered within 50 ms with `session is stuck: 'evaluate' is still running after a reload; run 'bowser close'`.
  - `ping is not affected while stuck`.
  - `the mark clears when the stuck op settles`, after which the next request runs.
  - `a request already queued when the mark clears runs normally`.
  - `a second timed-out op while stuck does not recover twice` (recover is called once).
  - `with budgets off no mark is ever set`.
- [ ] **Step 2:** Run `bun test tests/daemon-handler.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement it. Only the op that holds the serializer can be the stuck one.
- [ ] **Step 4:** Run `bun test`, then `BOWSER_E2E=1 bun test tests/e2e-hangs.test.ts`. Where an F9 test now sees the stuck message instead of the queue message, update its assertion and list it in the task report.
- [ ] **Step 5:** Commit: "A session whose op outlived recovery answers 'stuck' at once (#78)".

### Task 4: Timeouts say whether the action was delivered

**Files:**
- Modify: `src/browser.ts` (`nav.act`, and `Browser` gains `readonly phase: "idle" | "acting" | "awaiting-navigation"`); `src/daemon/server.ts` (`timeoutMessage` takes the phase)
- Test: `tests/browser.test.ts`, `tests/daemon-handler.test.ts`

**Interfaces:**
- Produces: `Browser.phase`. It is `acting` from the start of `act` until the action resolves, then `awaiting-navigation` until `act` returns, and `idle` otherwise, including after a throw. `dispatch` reads it when the timer fires: `awaiting-navigation` gives the delivered message, and every other phase keeps today's.

- [ ] **Step 1: Write the failing tests:**
  - browser: `phase is awaiting-navigation while act waits for a landing`;
  - browser: `phase resets to idle when the action throws`;
  - handler: `a timeout while awaiting navigation says the click was delivered` (fake browser with `phase: "awaiting-navigation"`), with the exact delivered message.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5:** Commit: "A timeout during the navigation wait says the action was delivered (#78)".

### Task 5: The budget is per command

**Files:**
- Modify:
  - `src/daemon/protocol.ts` (`DaemonRequest.budgetMs?: number`);
  - `src/daemon/client.ts` (`DaemonClient` records its creation time; `request` sends `budgetMs = budget - elapsed` when the budget is on);
  - `src/daemon/server.ts` (`dispatch` times the request with the smaller budget; `opTimeoutMs` moves to a module both sides import, e.g. `src/budget.ts`).
- Test: `tests/daemon-handler.test.ts`, `tests/daemon.test.ts` or a client unit test through a fake socket.

**Interfaces:**
- Produces: `export function opTimeoutMs(): number` in `src/budget.ts`, with the same semantics as today's; `DaemonRequest.budgetMs`.

- [ ] **Step 1: Write the failing tests:**
  - handler: `a request with budgetMs smaller than the daemon's budget times out at budgetMs`;
  - handler: `budgetMs <= 0 fails at once with the timeout message`;
  - client: `the second request of a command carries the budget left`: the budget is 1000 ms and the first request takes about 300 ms, so the second's `budgetMs` is ≤ 700;
  - client: `no budgetMs when budgets are off`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5:** Commit: "A command's budget covers all its steps (#78)".

### Task 6: ET-10, per Task 1's verdict

**Files:**
- Modify: `src/browser.ts` (`nav.act`) and/or `src/daemon/server.ts`, as the verdict requires.
- Test: `tests/browser.test.ts`

**Interfaces:**
- Consumes: Task 1's report.

- [ ] **Step 1:** If the verdict is `other`, STOP and report NEEDS_CONTEXT with the report's evidence. Implement nothing.
- [ ] **Step 2 (`pending-navigation`): Write the failing test** `an action waits for a navigation a previous command left pending, then fails with 'page is still loading'`, using a fake view with `loading` true for longer than the budget. The exact ET-10 message is in Global Constraints.
- [ ] **Step 3:** Implement it. At the start of `act`, while the view is still loading a navigation that an earlier op started, wait within the remaining budget. If it is still pending at the deadline, throw the ET-10 message as a runtime error.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5:** Commit: "An action waits for a navigation left pending, or says the page is still loading (#78)".

### Task 7: End-to-end proof and docs

**Files:**
- Create: `tests/e2e-known-state.test.ts`
- Modify: `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Write the e2e tests**, one per DoD item 1–6, with a temp HOME, a `Bun.serve({port:0})` fixture (a server that never answers, a POST that never answers, a page served after 3 s, a reachable never-settling promise), a hard deadline per spawn, and cleanup of every process.
- [ ] **Step 2:** Run `BOWSER_E2E=1 bun test tests/e2e-known-state.test.ts` 3 times. Expected: PASS each time. Record in the report which cases fail on `origin/main`, using a temporary worktree in the scratchpad.
- [ ] **Step 3: Docs.** README and SKILL.md explain the stuck message (`run 'bowser close'`), the delivered message (check the page before retrying) and the per-command budget. CHANGELOG `[Unreleased]` gets `### Fixed` / `### Changed` entries citing #78.
- [ ] **Step 4:** Run `bun run check && BOWSER_E2E=1 bun test`. Expected: 0 failures, including `tests/e2e-hangs.test.ts`, `tests/e2e-session-gate.test.ts` and the MCP tests.
- [ ] **Step 5:** Commit: "e2e proof and docs for a known state after a timeout (#78)".
