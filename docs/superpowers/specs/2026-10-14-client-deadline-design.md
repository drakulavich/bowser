# A client-side deadline for daemon requests (ET-59, #155)

## Problem

`BOWSER_OP_TIMEOUT_MS` is the budget for a whole command, and agents rely on it to bound what a
command can cost them. Only the daemon enforces it: `dispatch` (`src/daemon/server.ts:169`) starts
one timer per request and sends the timeout reply when it fires. The client sends the remaining
budget with each request (`DaemonClient.request`, `src/daemon/client.ts:108`) and then waits for a
reply with no timer of its own. A daemon that stops running mid-op never fires its timer, so the
command waits for good.

Evidence, from S4 "Daemon frozen mid-op" in
`docs/superpowers/exploratory-testing/2026-10-14-session-log.md` (ET-59, confirmed, 3 runs; SIGSTOP
stands for a frozen or swapped-out process):

- `goto` with the default 30 s budget, SIGSTOP at 1 s: still waiting when `alarm` killed it at
  90 s, rc 142 (`st1`).
- `eval` of a 5 s promise with `BOWSER_OP_TIMEOUT_MS=3000`, SIGSTOP at 0.5 s: still waiting at
  25 s, rc 142 (`st5`).
- Through `bowser mcp` with a 3 s budget: the `eval` in flight and a second `eval` on the same
  session got no reply in 20 s and 10 s; MCP `ping` answered (`m2.ts`).

A command started after the freeze is fine. Its 1 s health ping (`HEALTH_PING_MS`,
`src/daemon/client.ts:136`) times out and it fails with `daemon for session 'k' did not answer; run
'bowser close -s k' to stop it` in 1052 ms (`st2`), and that `close` works (`closed session 'k'
(ended unreachable daemon 3261)`).

The MCP case is worse than the CLI one. `createMcpServer` runs one session's calls one after
another on a promise chain (`src/mcp.ts`), so the call that never returns holds every later call
on that session behind it.

## Change

### 1. Each request gets a client deadline

`DaemonClient.request` already fixes the command's start (`this.start`, set by the first request
that is not `ping`) and sends `budgetMs`, the time the command has left. When it sends a budget
(budget above 0 and a start set), it also starts a timer that fires at

    start + budget + CLIENT_MARGIN_MS

so every request of one command shares one deadline, as the budget does. With
`BOWSER_OP_TIMEOUT_MS=0` the client sets no timer, as the daemon sets none: 0 still means no
deadline. The health pings in `connectOrSpawn` run before `start` is set and keep their own 1 s
bound.

The timer is cleared when the request settles, by a reply or by the socket closing. A timer left
pending would keep the CLI process alive after it printed its answer.

### 2. What expiry does

When the timer fires, the client:

1. fails every request still pending on this connection with `DaemonNotAnswering` (the existing
   class and message: `daemon for session '<s>' did not answer; run 'bowser close -s <s>' to stop
   it`);
2. marks itself closed with that same message, so a later `request` on this client fails at once
   with it instead of with "closed the connection";
3. ends the socket (`sock.end()`).

`DaemonNotAnswering` is a plain `Error`, so the CLI exits 2, the code of the daemon's own timeout
reply. `withClient`'s `finally` still calls `close()`, which is then a no-op.

The socket closes from the client side. If the daemon resumes (SIGCONT), the request is still in
its socket buffer: it runs the op and writes a reply to a closed connection, and the gate lets the
next connection in once that request is done, as it does for any client that goes away. Whether the op itself
should stop is ET-38, out of scope here. Nothing on disk changes: the session dir, socket file and
pidfile stay, so `bowser close -s <s>` finds the daemon and ends it, as `st5` showed.

### 3. The MCP session queue

`bowser mcp` needs no code change. The failed call's `run()` rejects, `runToolCall` turns that into
an `isError` tool result with the message, and the session's chain moves on. The next call on that
session opens a new connection, its health ping times out after 1 s, and it fails with the same
message. So a frozen daemon costs the call in flight its budget plus the margin, and each later
call 1 s. The CANCELLATION comment in `src/mcp.ts:290` ("the session's next call still waits for
it to finish") changes to say the wait ends at the running call's deadline.

### 4. The margin: 2000 ms

The client deadline is a backstop. A daemon that is running must always be the one to answer,
because its timeout reply says more: the command, the step, and whether the action was delivered.
So the margin must cover everything between the daemon's timer firing and the reply arriving:

- the daemon's timer counts from receipt, a little after the client's `start`;
- the daemon's event loop may be late to fire the timer under load;
- at the deadline the daemon runs `timedOut` and `cancelAction` before it writes the reply, and the
  reply crosses the socket.

All of these take milliseconds on a working machine. The existing bound for "a live daemon
answers" is `HEALTH_PING_MS`, 1 s for an idle daemon; a busy one at its deadline gets twice that.
A bigger margin only makes a frozen daemon cost more: at the
default 30 s budget, 2 s adds under 7%. A fixed margin rather than a share of the budget keeps a
3 s budget from getting a margin too small to absorb a loaded machine.

```mermaid
sequenceDiagram
    participant C as CLI / MCP call
    participant D as daemon
    C->>D: request (budgetMs = B)
    Note over C: client timer: start + B + 2 s
    alt daemon running
        Note over D: timer fires at B
        D-->>C: 'eval' timed out after B ms (exit 2)
        Note over C: client timer cleared
    else daemon frozen (SIGSTOP)
        Note over D: no timer, no reply
        Note over C: B + 2 s: did not answer; run 'bowser close -s k' (exit 2)
        C->>D: socket end
    end
```

### 5. Docs

README (`BOWSER_OP_TIMEOUT_MS` row) and `skills/bowser/SKILL.md` (its bullet) get one sentence: if
the daemon itself stops answering, the command gives up 2 s after its budget with `daemon for
session '<s>' did not answer; run 'bowser close -s <s>' to stop it` (exit 2), and `bowser close -s
<s>` ends it.

## Tests

In `tests/lifecycle.test.ts`, under `describe("ET-59: a daemon that stops answering mid-op")`, with
a fake daemon on the session's real socket (`tests/helpers/fake-daemon.ts`) rather than a SIGSTOP of
a real browser. Each test sets `BOWSER_OP_TIMEOUT_MS` in `process.env` and restores it. The helper
gets one change: `answer` may return a promise, so a test can delay a reply.

1. **ET-59: a command fails at budget plus margin when its daemon stops answering mid-op.** The fake
   answers `ping` with `pkg.version` and never answers `evaluate`. Budget 300 ms. `run(["eval",
   "1", "-s", s])` fails with `bowser: daemon for session 's' did not answer; run 'bowser close -s
   s' to stop it`, exit 2, after at least 2300 ms and under 3300 ms. Today it never returns.
2. **ET-59: the daemon's own late timeout reply wins over the client deadline.** The fake answers
   `evaluate` with `ok: false` and `'eval' timed out after 300ms` 1300 ms after receipt (budget
   300 ms, so 1 s past the budget and 1 s inside the margin). The command fails with the daemon's
   message, exit 2. Guards against a margin cut too fine.
3. **ET-59: budget 0 sets no client deadline.** Budget 0, the fake answers `evaluate` with `1`
   after 2500 ms (past the margin). The command prints `1`.
4. **ET-59: over MCP, the next call on the session answers after the frozen one fails.** A fake
   that stops answering everything, `ping` included, once it receives `evaluate`, as a stopped
   process does. `createMcpServer` with `run` from `src/cli.ts`, budget 300 ms, two `eval`
   tools/calls on that session. The first gets an `isError` result with the "did not answer"
   message within 3300 ms; the second gets the same message within 1500 ms after the first. Today
   neither answers.

Tests 2 and 3 pass today and stay as guards for the margin and for budget 0; tests 1 and 4 are
the ET-59 failures.

## Out of scope

The other #155 items: ET-38, ET-52, ET-58, ET-60, ET-63, ET-64. A command run with
`BOWSER_OP_TIMEOUT_MS=0` against a frozen daemon still waits for good, as 0 asks.

## Definition of Done

- `bun test tests/lifecycle.test.ts -t 'ET-59'`: 4 pass, 0 fail.
- `grep -c "did not answer" README.md skills/bowser/SKILL.md`: at least 1 for each file.
- `bun run check`: exit 0 (typecheck, lint, and the suite with the new tests).
- `BOWSER_E2E=1 bun test`: exit 0. The repo's rule for a daemon change; `tests/e2e-hangs.test.ts`
  and `tests/e2e-mcp.test.ts` show a real daemon's timeout replies still reach the client before
  the client deadline.
