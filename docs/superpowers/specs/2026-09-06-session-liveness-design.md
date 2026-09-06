# Spec: a session is live or it is gone

**Status:** approved. Plan: `docs/superpowers/plans/2026-09-06-session-liveness.md`.
**Origin:** ticket 2 of the post-refactor triage (`list` prints every session
ever created). Investigating it found a process leak underneath, and the ticket
grew to cover both. Also closes ET-01 from the exploratory campaign.

## Assumptions

Correct any of these now, or I proceed with them.

1. `list` is a bowser extension, not a compatibility surface. **Measured:**
   `playwright-cli` 0.1.13 has no `list` command — its session-management verbs
   are `close` and `delete-data`. So its semantics are ours to define, and no
   differential test constrains them.
2. Deleting a closed session's directory is acceptable data loss. After `close`
   the state file holds `url: ""` and no refs; nothing in the tool reads a
   closed session's state.
3. A session with no reachable daemon is not a session an agent can use, even
   if a process for it survives somewhere. `list` should not show it.
4. Nobody depends on `list` printing closed session names in a script.

## What was measured

On this machine, before any change:

| | |
|---|---|
| session directories under `~/.bowser/sessions` | **640** (2.5 MB) |
| of those, with a `sock` file | **2** |
| with `state.json` whose `url` is `""` (closed) | 639 |
| `bowser list` output lines | **640** |

### The process leak, reproduced deterministically

`close` reports success and exits 0 while the daemon process keeps running:

```
$ bowser -s probe open https://example.com        # daemon pid 38616
$ rm ~/.bowser/sessions/probe/sock                # simulate an unreachable daemon
$ bowser -s probe close
closed session 'probe'                            # exit 0
$ kill -0 38616 && echo alive
alive                                             # holding a browser view, now unreachable
```

The mechanism is in `closeOne` (`src/commands/navigation.ts:69`): it connects
with `{ spawn: false }`, and a failure to connect is swallowed — the comment
says "no daemon; that's ok" — after which it unlinks the socket, writes an empty
state, and reports the session closed. If a process *was* running, it is now
orphaned with no socket, unreachable by any bowser command.

This is not hypothetical: ten such daemons from an earlier probe in this session
survived for hours, each holding a WebKit view, and were found only by `pgrep`.

It is the same class as the `cookie-set` defect fixed in #30 — reporting success
for something that did not happen — but it leaks processes rather than
mis-setting an attribute.

## Objective

1. **`close` stops lying.** When it cannot confirm the daemon is gone, it says
   so and exits non-zero, rather than reporting the session closed.
2. **`close` leaves nothing running.** Where it can identify the process, it
   ends it.
3. **`close` leaves nothing on disk.** The session directory is removed, so
   closed sessions cannot accumulate.
4. **`list` shows only sessions that can be used**, so its output is something
   an agent can act on without checking each entry.

## Approved decisions

Settled before this spec was written:

1. **Scope:** the orphan fix and `list` ship together. Fixing `list` alone would
   build its filter on socket presence — the one signal the orphan case
   falsifies.
2. **`list` semantics:** live sessions only. No `--all` flag; `ls
   ~/.bowser/sessions` remains available for anyone who wants the raw list, and
   after decision 3 there is little left to see.
3. **Accumulation:** `close` removes the session directory, matching the
   reference's `delete-data` in spirit.

## One addition these decisions imply, not covered by them

**A pidfile.** `close` cannot today verify that the daemon died — the directory
holds only `sock` and `state.json`, and `src/daemon/main.ts` records nothing
about the process. Without a pid, objective 2 is unreachable and objective 1
degrades to "warn that something might still be running".

Proposed: the daemon writes `pid` beside `sock` at startup and removes it on
clean shutdown. `close` reads it, and after a failed or skipped shutdown checks
whether that process is alive; if it is, it ends it and says so.

**Guard against pid reuse:** never signal a pid without first confirming the
process is ours. On macOS, `ps -o command= -p <pid>` must contain the session
name and either `--daemon` or `daemon/main.ts`. A pid that fails this check is
treated as already gone and the stale file removed.

**The cheaper alternative, if the pidfile is unwanted:** `close` reports
honestly ("could not reach the daemon for 'x'; a browser process may still be
running") and exits non-zero, but kills nothing. That fixes the lie and leaves
the leak. Say which you want; the plan follows either.

## Tech Stack

Bun 1.4.0, TypeScript 7.0.2. Zero runtime dependencies, Bun-native APIs only.

## Commands

```
Typecheck (the real gate): bun run typecheck
Unit tests:                bun test
WebKit e2e:                BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
Orphan check after a run:  pgrep -fl "daemon/main|--daemon"
```

macOS here has no `timeout`; wrap long commands as
`perl -e 'alarm 600; exec @ARGV or die' -- <command>`.

## Project Structure

```
src/daemon/main.ts            → writes and removes the pidfile
src/daemon/server.ts          → removes the pidfile on shutdown
src/daemon/client.ts          → socketPath(); a pidPath() belongs beside it
src/commands/navigation.ts    → cmdClose/closeOne/closeAll, cmdList
src/state.ts                  → session directory helpers
tests/commands.test.ts        → cmdList and cmdClose over a fake client
tests/daemon.test.ts          → daemon lifecycle
```

## Code Style

Liveness is one predicate, defined once and used by both commands. Sketch:

```ts
/** A session is live when its daemon answers. The socket file alone is not
 *  enough — a stale socket outlives a crashed daemon — and a pid alone is not
 *  enough either, since an orphan holds no socket. */
async function isLive(session: string): Promise<boolean> {
  try {
    const c = await connect(session, { spawn: false });
    try { await c.request("ping"); return true; } finally { c.close(); }
  } catch { return false; }
}
```

`ping` is on the urgent lane as of PR 6, so a wedged daemon still answers it —
a busy session reads as live, which is correct.

## Testing Strategy

Required coverage:

- Unit: `list` omits a session directory with no socket. Must fail against
  today's code, which lists every directory.
- Unit: `list` includes a session whose daemon answers `ping`.
- Unit: `close` removes the session directory.
- Unit: `close` exits non-zero when it cannot confirm the daemon stopped.
- Unit: the pid-ownership guard refuses a pid whose command line does not name
  the session — the test that stops this from ever killing an unrelated process.
- Integration: open a real session, delete its socket, `close`, and assert both
  that the command fails **and** that no daemon process for that session
  survives. This is the reproduction above, turned into a test.
- Regression: `close --all` still closes several sessions, and now leaves no
  directories behind.

## Boundaries

- **Always:** confirm a process is ours before signalling it; run the full gate
  before committing; check `pgrep` after e2e runs so this fix does not itself
  leak.
- **Ask first:** adding a `list --all` or a separate `prune` command — both were
  considered and rejected above; changing what `close --all` prints.
- **Never:** kill a pid without the ownership check; delete a session directory
  while its daemon is still reachable; report a session closed without evidence
  it is.

## Success Criteria

1. `bowser list` prints only sessions whose daemon answers. On this machine that
   is 2 lines, not 640.
2. `bowser close` on a session whose socket is missing but whose process lives
   ends that process and reports what it did; the reproduction above no longer
   leaves an orphan.
3. `bowser close` exits non-zero when it cannot confirm the daemon stopped.
4. After `close`, the session directory does not exist.
5. A full WebKit e2e run leaves no daemon behind, checked with `pgrep`.
6. `bun run typecheck` clean, `bun test` green, WebKit e2e green.

## Open Questions — settled

1. **The pidfile** — approve it, or take the report-only alternative? See the
   section above. **Decided: the pidfile.** Objective 2 is the half of
   this ticket that actually stops the leak, and ten orphaned browsers went
   unnoticed for hours precisely because nothing reported or ended them.
2. **What `close` should do about a session that does not exist at all.** Today
   it reports success for any name. With directories now deleted, `close
   typo-name` will be the common way to hit this. Options: stay silent and
   succeed (idempotent, current behaviour), or report "no such session" and exit
   non-zero. **Decided: keep it succeeding** — `close` is what an agent
   calls in a cleanup path, and failing there is noise.
