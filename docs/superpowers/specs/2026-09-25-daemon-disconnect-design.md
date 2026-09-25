# Spec: a request fails when its daemon goes away

**Status:** approved (backlog item 1, 2026-09-25 priority list).
**Origin:** "A request whose daemon exits never settles", raised by PR 6's
final review and recorded in the maintainability refactor spec's backlog
notes. It predates that series.

## Problem

`DaemonClient` (`src/daemon/client.ts`) keeps a `pending` map from request id
to callback and settles an entry only when a reply line for that id arrives.
Nothing handles the socket closing. If the daemon exits, crashes or is killed
while a request is in flight, that request's promise neither resolves nor
rejects. The CLI command then hangs until something external kills it. The
health-check `ping` is bounded by `withTimeout`; no other request is.

An agent drives bowser in a loop, so one hung command stalls the whole agent
turn with no error to act on.

## Behaviour

1. When the client's socket closes, reports an error or ends from the peer
   side, every pending request rejects immediately with
   `daemon for session '<session>' closed the connection` (for an error
   event, the error message may be appended after `: `). A request that has
   already settled is untouched.
2. A `request()` issued after the socket has closed rejects immediately with
   the same message instead of writing to a dead socket.
3. The client's own `close()` is not a daemon failure. The CLI only calls
   `close()` after its requests have settled, so no pending request should
   be left to reject then. If one is, it rejects with the same message
   rather than hanging.
4. The failing command exits with code **2** (runtime error) and prints the
   message. It must not match the user-error regex in `src/cli.ts`.
5. Nothing else changes: normal replies, the health check, spawn, and every
   existing command keep their current behaviour and output.

To carry `<session>` in the message, the client needs the session name. It
already has the socket path; how it gets the name (constructor argument or
derived) is an implementation choice. The error must name the session.

## Tests (public seams only)

- **Client seam** (`tests/daemon.test.ts`, which already drives
  `connectOrSpawn` against real Unix sockets): a fake daemon made with
  `Bun.listen` answers `ping`, then closes the connection when it receives
  the next request. `await client.request(<any op>)` must reject with the
  message above, well under one second. A second case: a request made after
  the peer has closed rejects immediately.
- **CLI seam** (e2e, `BOWSER_E2E=1`, the backend that resolves, with
  `$HOME` redirected as the other e2e files do): open a session, start a
  command that stays in flight (for example `eval` of a promise that
  resolves after 30 s), kill the daemon with SIGKILL using the pid in
  `~/.bowser/sessions/<name>/pid`, and assert the command settles with the
  message and a runtime-error result within a few seconds, not 30.
- Test names describe behaviour ("a request in flight fails when its daemon
  dies"), not functions. No fixed sleeps as the pass condition: wait on the
  promise with a bound.

## Out of scope

- Reconnecting or respawning after the daemon dies. The next command already
  spawns a fresh daemon through `connectOrSpawn`.
- A general per-request timeout. `BOWSER_OP_TIMEOUT_MS` bounds work inside
  the daemon; a client-side timeout is a separate decision.
