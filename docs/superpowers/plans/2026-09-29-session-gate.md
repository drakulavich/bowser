# Session Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commands of different clients on one session run one at a time, whole, so they no longer interleave (#77).

**Architecture:** A pure FIFO gate in the daemon (`src/daemon/gate.ts`) whose holders are socket connections. `dispatch` enters the gate before the existing serializer. The gate passes on when the holder's socket closes, or when the holder stays idle past the op budget. Urgent ops bypass it. Ref commands read `state.json` inside their client.

**Tech Stack:** Bun, TypeScript, `bun:test`, Bun.WebView (WebKit, macOS).

**Spec:** `docs/superpowers/specs/2026-09-29-session-gate-design.md`. Its "Definition of done" section is the acceptance list.

## Global Constraints

- No CLI↔daemon protocol change. `DaemonOps` and the request and response shapes stay as they are.
- Urgent ops (`urgent: true` in `DaemonOps`: `ping`, `shutdown`) never wait at the gate.
- A request's budget (`BOWSER_OP_TIMEOUT_MS`, default 30000) runs from receipt, and time at the gate counts toward it.
- The message for a request that times out at the gate is exactly: `` `${timeoutMessage(req, ms)} (waiting for another client's command on this session)` ``, exit 2.
- With `BOWSER_OP_TIMEOUT_MS=0` (budgets off), an idle holder is never released; only a socket close releases it.
- `bun run check` and `BOWSER_E2E=1 bun test` pass. Comments only where a reader would otherwise break something silently.

## Review Focus

- **A holder's socket closes while its own later request is still queued at the serializer.** The gate passes on only after that request settles; it must not hand over mid-op. Test in Task 2.
- **A waiting connection closes before it gets the gate.** It leaves the queue, and the next waiter is not stuck behind it. Test in Task 1.
- **An idle holder sends again after losing the gate.** It re-enters at the back of the queue; it does not jump ahead or throw. Test in Task 1.
- **Budgets disabled (`0`).** No idle release, and no timer leaks. Test in Task 1.
- **One MCP server.** Every call is its own connection. Its per-session chain already orders them, so nothing changes: the existing `tests/mcp-concurrency.test.ts` and `tests/e2e-mcp.test.ts` pass unchanged (Task 4 runs them).

---

### Task 1: The gate

**Files:**
- Create: `src/daemon/gate.ts`
- Test: `tests/gate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Gate {
    /** Resolves when `conn` holds the gate (at once if it already does), with
     *  `done`, to call when this request has settled. Rejects if `conn`
     *  leaves before its turn. */
    enter(conn: object): Promise<() => void>;
    /** `conn`'s socket closed: drop it from the queue, or release the gate
     *  once its entered requests are all done. */
    leave(conn: object): void;
  }
  export function createGate(idleMs: number): Gate;
  ```
  The holder counts its entered-but-not-done requests. When the count drops to 0, an `idleMs` timer starts (none when `idleMs <= 0`). If it fires, the gate passes to the next waiter, and a later `enter` from the old holder queues at the back. `leave` of the holder while its count is above 0 releases when the count reaches 0.

- [ ] **Step 1: Write the failing tests** in `tests/gate.test.ts`:
  - `a second connection waits until the first leaves`: A enters; B's `enter` is still pending after a tick; `leave(A)`; B resolves.
  - `the holder's own requests enter at once and in order`.
  - `waiters are served in arrival order` (A holds; B, then C; `leave(A)` → B; `leave(B)` → C).
  - `a holder is released only after its entered requests are done`: A enters twice; `leave(A)`; B still pending; the first done → still pending; the second done → B resolves.
  - `an idle holder loses the gate after idleMs` (idleMs 50): A enters and calls done; B is waiting; after ~60 ms B resolves. A's next `enter` stays pending until `leave(B)`.
  - `a busy holder is never idled out`: A entered and not done for 3× idleMs; B still pending.
  - `a waiter that leaves before its turn is dropped`: A holds; B and C wait; `leave(B)` → B's enter rejects; `leave(A)` → C resolves.
  - `idleMs 0 never releases an idle holder`: A done; B pending after 100 ms.
- [ ] **Step 2:** Run `bun test tests/gate.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3:** Implement `createGate` in `src/daemon/gate.ts`: a holder, a queue of `{conn, resolve, reject}`, and per-holder counts.
- [ ] **Step 4:** Run `bun test tests/gate.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit with `git add src/daemon/gate.ts tests/gate.test.ts && git commit -m "Daemon gate: one connection at a time per session (#77)"`.

### Task 2: dispatch goes through the gate

**Files:**
- Modify: `src/daemon/server.ts`: `Lane` (line ~56), `dispatch` (~96), the socket handler in `startDaemon` (~412)
- Test: `tests/daemon-handler.test.ts`

**Interfaces:**
- Consumes: `createGate`, `Gate` from Task 1.
- Produces: `Lane` gains `gate?: Gate` and `conn?: object`. When both are set, a non-urgent request `await`s `lane.gate.enter(lane.conn)` before `lane.serialize(...)`. It calls `done` when its serialized task settles, recovery included, or at once when it was answered (timed out) before it entered. `startDaemon` creates one gate (`createGate(timeoutMs)`) and, per socket, a `conn` object. It calls `gate.leave(conn)` from the socket's `close` handler, which must be added, and from `error`.

- [ ] **Step 1: Write the failing tests** in `tests/daemon-handler.test.ts`, driving `dispatch` with two lanes that share one gate and one serializer:
  - `requests of a second connection wait until the first connection closes`: conn A sends `evaluate` (slow handler); conn B sends `evaluate`; A sends another; order of `handle` calls is A, A, B, and B starts only after `gate.leave(A)`.
  - `urgent ops skip the gate`: A holds; B's `ping` is answered at once.
  - `a request that times out at the gate says so`: timeoutMs 50; A holds; B's `evaluate` reply error is `'evaluate' timed out after 50ms (waiting for another client's command on this session)`.
  - `the gate is not handed over while the holder's op still runs`: A's op is running; `leave(A)`; B's `handle` is not called until A's op settles.
- [ ] **Step 2:** Run `bun test tests/daemon-handler.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the `Lane`/`dispatch` changes and the `startDaemon` wiring described under Interfaces. The existing "waiting for '<op>', which timed out" message stays for a request that entered the gate and waits at the serializer.
- [ ] **Step 4:** Run `bun test tests/daemon-handler.test.ts tests/lifecycle.test.ts tests/daemon.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: "dispatch enters the session gate before the serializer (#77)".

### Task 3: Dropped

Dropped during implementation, as the spec's section 2 explains: connecting sends only `ping`, which bypasses the gate, so moving `loadRef` gains nothing and changes nine behaviours users can see. `liveSelector` already resolves the ref under the gate. The original text is kept below for the record.

### (Dropped) Task 3: Ref commands read state under the gate

**Files:**
- Modify: `src/commands/interaction.ts:34,96,166,174,184,193` (every `loadRef` call)
- Test: `tests/commands.test.ts`

**Interfaces:**
- Consumes: `withClient`/`withPageClient`, `loadRef` (unchanged signatures).
- Produces: every `loadRef(ctx.session, ref)` call runs inside the `withClient`/`withPageClient` callback, before the first `c.request`. Argument checks that need no state (usage errors) stay before the client.

- [ ] **Step 1: Write the failing test** `a ref command reads the state saved before it got the session`: save state with `e3` as a checkbox; make `connect` a fake whose connect step first saves state with `e3` as a textbox, then returns `fakeClient()`; `cmdFill(ctx, "e3", "x")` succeeds. Today it throws `ref 'e3' is not a textbox`-style from the stale kind.
- [ ] **Step 2:** Run `bun test tests/commands.test.ts`. Expected: the new test FAILS.
- [ ] **Step 3:** Move each `loadRef` into its callback.
- [ ] **Step 4:** Run `bun test`. Expected: PASS.
- [ ] **Step 5:** Commit: "Ref commands read state after they get the session (#77)".

### Task 4: End-to-end proof and docs

**Files:**
- Create: `tests/e2e-session-gate.test.ts`
- Modify: `README.md` (Multiple sessions section), `skills/bowser/SKILL.md` (sessions section), `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**
- Consumes: the whole branch. Spawn real CLI processes (`bun src/cli.ts …` via `Bun.spawn`) in parallel, since parallel clients are the point. Use a temp HOME and a local `Bun.serve({port: 0})` fixture.

- [ ] **Step 1: Write the e2e tests** (skipped unless `BOWSER_E2E=1`), one per spec DoD item 1–6:
  - **ET-20:** a form with Name, Password and Email. Run three parallel `fill`s 10 times: every call exits 0, the field values equal their own texts, and `snapshot` never contains the password.
  - **ET-16:** page one has `button "Buy A"`; `/two` has `button "DELETE"` at the same selector. Race `click e2` against `goto /two` from another process 10 times. The click either exits 1 with `not found in the current page snapshot`, or it clicked on page one (a page-one handler sets `document.title`). `DELETE`'s handler never fires.
  - **ET-17:** six parallel `open`s of `/x1`…`/x6`; each output names its own URL.
  - **close:** a holder is stopped with `process.kill(pid, "SIGSTOP")` mid-command (use an `eval` of a 5 s promise); `close` exits 0 within 2 s. Send SIGCONT/kill after.
  - **kill -9 release:** kill a holder mid-command; the next command runs at once. **Idle release:** with `BOWSER_OP_TIMEOUT_MS=3000`, a stopped holder's gate passes after about 3 s and the waiting command succeeds.
  - **waiting message:** with `BOWSER_OP_TIMEOUT_MS=1000`, while another client holds the gate with a 5 s eval, a second command exits 2 with `(waiting for another client's command on this session)`.
- [ ] **Step 2:** Run `BOWSER_E2E=1 bun test tests/e2e-session-gate.test.ts` on this branch. Expected: PASS. On `origin/main` the ET-20/ET-16/ET-17 cases fail; record that in the PR.
- [ ] **Step 3: Docs.** README and SKILL.md gain one sentence each: commands on one session run one at a time, and parallel calls wait their turn. CHANGELOG `[Unreleased]` gets a `### Fixed` entry citing #77.
- [ ] **Step 4:** Run `bun run check && BOWSER_E2E=1 bun test`. Expected: 0 failures, including `tests/mcp-concurrency.test.ts` and `tests/e2e-mcp.test.ts` unchanged, and `tests/docs-drift.test.ts`.
- [ ] **Step 5:** Commit: "e2e proof and docs for one command at a time per session (#77)".
