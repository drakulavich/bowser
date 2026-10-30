# An MCP server that was running during a restart gets its notice on its next call (#261)

Amends `2026-10-14-restart-close-notice-design.md` (ET-29) and its ET-44 change in PR #260.

## Problem

After an upgrade restart of an ephemeral session, the restart notice is the only place that says cookies and
storage are gone. `takeNotice` (`src/commands/context.ts`) reads `msg.done` only for a command that waited on the
restart. A second `bowser mcp` server B, idle while server A's call restarts the session, makes its next call after
A printed the notice: `msg` is gone, B did not wait, and B reads `localStorage` as `null` with no notice. Usually
that call runs in B's handover child (`startHandover`, `src/mcp.ts`), a process that starts after the restart.

A CLI command keeps today's rule.

## Change

A `bowser mcp` process keeps `since`, its start time, and `seen`, a map from session name to the mtime of the last
notice it put in a response for that session. In an MCP call:

- a call that neither restarted nor waited also reads `msg.done`, and takes it when its mtime is later than
  `seen.get(session) ?? since`;
- a notice from `msg` whose mtime is not later than `seen.get(session)` is not taken again;
- every notice the call put in its response records its file's mtime in `seen`, from an ack that runs after the
  response is written (`if (!token.cancelled && (await send(res)))`, `src/mcp.ts`). Only the restarter's ack and the
  pending-`msg` ack call `markDelivered`, as today; the others leave both files in place (ET-44).

A handover child sets `since` to 0 when it accepts an `initialize` whose id is `bowser-handover` (`HANDOVER_ID`,
`src/mcp.ts`). Without it the child, started after the restart, misses the case this issue is about. Its parent
runs an older bowser, so it started before every restart to the installed version.

`since` is needed because `msg.done` stays until the next restart or `close`: with `seen` alone, every new server
would print the last notice once, however old. The rename to `msg.done` keeps the file's mtime (checked on APFS).

In code: `CommandContext` gets `restarts?: { since: number; seen: Map<string, number> }`; `readNotice` returns the
file's `mtimeMs` with its text; `createMcpServer` holds one `restarts` per process and passes it to `deps.run` with
`notices` and `acks`. The CLI passes no `restarts`. Cost: one more read of `msg.done` per MCP call that neither
restarted nor waited, and a map entry per session the server printed a notice in.

Left for later, in #273: a server started after the restart, a client that never sends `initialize`, and clock
steps. The options weighed are in a comment on #261.

## Definition of Done

- [x] `tests/lifecycle.test.ts`, test "a late MCP call gets the last restart's delivered notice once (#261)", with
  `run(argv, { notices, acks, restarts })` against a fake daemon of this version and a `msg.done` written in the
  test:
  - `since` before the file's mtime: `notices` equals the file's text, `msg.done` still holds it after the acks run,
    and a second call with the same `restarts` gets `[]`;
  - `since` after the file's mtime: `[]`;
  - without `restarts`: `[]`, and `acks` is `[]`.
- [x] `tests/lifecycle.test.ts`, test "every notice an MCP call printed is recorded, so the next call does not repeat it
  (#261)": a second call with the same `restarts` gets `[]` after each of these: the restarter (its acks rename `msg`
  to `msg.done`), a pending `msg` (ET-29), both ET-44 waiter variants (after the ack, `msg` or `msg.done` still holds
  the text), and a waiter that read a pending `msg`, called again before the restarter's ack.
- [x] `tests/mcp.test.ts`, test "a handover child counts every restart as news (#261)": after an `initialize` with id
  `bowser-handover`, `deps.run` gets `restarts.since` 0; after another id, a `since` no earlier than the time taken
  before `createMcpServer`.
- [x] `tests/e2e-upgrade.test.ts`, test "an MCP server idle during another's restart gets its notice on its next call
  (#261)": two servers from `copyAt("old-mcp", "0.0.1")`, both initialized before the upgrade, on one ephemeral
  session with `localStorage` `tok` set. After the version bump A's call restarts it and carries the notice; B's
  first call, `localstorage-get tok`, answers text that starts with the notice and holds
  `cookies and storage were lost`; B's second call has no notice; a CLI `eval 1` then prints `1` and nothing on
  stderr.
- [x] `bun test tests/lifecycle.test.ts -t "#261"` and `bun test tests/mcp.test.ts -t "#261"` each run at least one
  test, all passing (today: `regex "#261" matched 0 tests`).
- [x] "Upgrading" in `docs/install.md` (moved there from README in #264):
  `grep -n "was running when the restart finished" docs/install.md` prints one line, and
  `grep -n "does not get it (#261)" docs/install.md` prints nothing (before: line 34).
- [x] CHANGELOG unreleased: `grep -n "was running when the restart finished" CHANGELOG.md` prints a line, and
  `grep -n "still gets no notice (#261)" CHANGELOG.md` prints nothing (before: line 33).
- [x] `bun run check` passes.
- [x] `BOWSER_E2E=1 bun test` passes in CI.
- [x] Each new unit test goes red under one mutation of the line it checks, quoted in the PR as one line per test.
  The e2e test was not mutated: `BOWSER_E2E` does not run locally.
