# One command at a time per session (#77)

**Issue:** #77 (ET-16, ET-17 and ET-20 from the 2026-09-28 exploratory campaign, `docs/superpowers/exploratory-testing/2026-09-28-session-log.md`).
**Status:** approved in conversation 2026-09-29; approach A.

## Problem

A bowser command is one connection to the session's daemon, carrying several requests. For example, `fill` sends a ref resolve, a click, the fill script and a type. The daemon serializes *requests*, not *commands*, so two clients of one session interleave:

- **ET-16:** `click e2` resolved its ref on page one. Another client's `goto` then ran, and the click landed on a different button on page two. It reported `clicked e2 (button "Buy A")`, exit 0.
- **ET-20:** three parallel `fill`s all reported success, but their text landed in one field. The next snapshot showed the password in the Email field.
- **ET-17:** parallel `open`/`goto` all report whichever URL landed last.

The clients that hit this are parallel CLI calls (a coding agent's parallel Bash calls), two MCP servers, and an MCP server plus the CLI. One MCP server already queues one session's calls.

## Decision

While a command of one client runs on a session, a command of another client **waits its turn**. It is not refused. Agents that issue parallel calls get them run one after another, correctly.

## Design

### 1. A per-session gate on connections (`src/daemon/gate.ts`)

A small pure module with no WebView: a FIFO gate whose holders are connections.

- A connection's first non-urgent request enqueues the connection at the gate. While the connection holds the gate, its requests go through the existing serializer, one op at a time. Other connections' requests wait at the gate.
- The gate is released when the holder's socket closes. That covers a command that finishes (`withClient` closes its client in `finally`) and a client that crashes (the socket closes).
- **Idle holder.** The holder loses the gate when it has had no request running or queued for longer than the op budget (`BOWSER_OP_TIMEOUT_MS`). This covers a client that is alive but stuck (SIGSTOP), which would otherwise hold the session until it died. A later request from that connection then enqueues again, like a first request.
- **Urgent ops** (`ping`, `shutdown`) bypass the gate, as they bypass the serializer today, so `close` always works.

`startDaemon`'s socket handler gives each connection an identity for the gate, and `dispatch` takes the gate before the serializer. The serializer and the recovery path are unchanged.

### 2. Commands are unchanged

Commands need no change. A ref command's first request resolves the ref in the live page (`liveSelector`), and that request already runs under the gate, so the element it acts on is the one the page has at that moment.

An earlier draft moved `loadRef` (the `state.json` read) inside `withClient`. That was dropped during implementation: connecting sends only `ping`, which bypasses the gate, so the read would still happen before the command held it. The move would also have changed nine behaviours users can see, such as a wrong-kind refusal no longer being made before any daemon request.

The CLI↔daemon protocol does not change.

### 3. Budget and errors

A request's budget still runs from receipt, and time spent waiting at the gate counts. A request that times out while waiting gets:

`… (waiting for another client's command on this session)`

with exit 2, as other runtime errors. No command reports success for another client's action.

## Cost

Commands on one session no longer overlap, so their times add up. They never ran in parallel in the daemon anyway, since requests were already serialized.

## Testing

- **Unit (gate):**
  - FIFO order across connections;
  - release on close;
  - an idle holder loses the gate after the budget;
  - urgent ops never wait;
  - a holder's own requests keep their order.
- **Daemon handler:** two fake connections; requests of the second wait until the first closes.
- **E2E** (`BOWSER_E2E=1`), from the campaign's repros:
  - three parallel CLI `fill`s on one form (ET-20): each field holds its own text, and no password appears in the next snapshot;
  - `click eN` racing a `goto` (ET-16): the click either fails with "ref not found" or acts on the page it resolved on, and never reports another element;
  - parallel `open`s (ET-17): each reports the URL it opened;
  - `close` succeeds while another client holds the gate idle.

## Definition of done

1. **ET-20 is fixed.** Three parallel CLI `fill`s on one form, run 10 times in a row, all end with each field holding its own text and every call exiting 0. The snapshot after each run shows no password value.
2. **ET-16 is fixed.** A `click eN` raced against a `goto` from another client, run 10 times, never reports `clicked` for an element other than the one the ref named on the page it resolved on. Each run either clicks on that page or fails with "ref not found" (exit 1).
3. **ET-17 is fixed.** Six parallel `open`s of different URLs each report the URL they opened.
4. **The session can always be closed.** `bowser close` succeeds within 2 s while another client holds the gate, and while that client is stopped with SIGSTOP.
5. **The gate is released.** A client killed with `kill -9` releases the gate as soon as its requests are answered. The next command runs once any op the client left in the page has settled, since the serializer orders the two. An idle holder (SIGSTOP) releases it after `BOWSER_OP_TIMEOUT_MS`, and the waiting command then runs.
6. **A waiting request fails clearly.** A request that times out while waiting at the gate fails with `(waiting for another client's command on this session)`, exit 2.
7. **One MCP server is unaffected.** Its concurrency tests (`tests/mcp-concurrency.test.ts`, `tests/e2e-mcp.test.ts`) pass unchanged. Two MCP servers on one session no longer interleave.
8. **Tests.** Every item above has a test: unit for the gate, a daemon handler test, and e2e for items 1–5. Each test was seen failing before the fix.
9. **Checks.** `bun run check` passes (typecheck, Biome/Knip lint, unit tests), and so does `BOWSER_E2E=1 bun test`. CI is green.
10. **Docs.** README and `skills/bowser/SKILL.md` say that commands on one session run one at a time, and that parallel calls wait their turn. CHANGELOG `[Unreleased]` has an entry.
11. **Review and issue.** A Codex review ends with no open Critical or Required finding, and #77 is closed by the PR.

## Out of scope

Timeout recovery and the navigation wait (#78) have their own spec.
