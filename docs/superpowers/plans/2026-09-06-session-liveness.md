# A session is live or it is gone — implementation plan

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `close` leaves no process and no directory behind, and says so honestly when it cannot; `list` shows only sessions an agent can use.

**Spec:** `docs/superpowers/specs/2026-09-06-session-liveness-design.md` — read it first, including the reproduction of the process leak.

**Approved decisions:**
1. The orphan fix and `list` ship together.
2. `list` shows live sessions only; no `--all` flag.
3. `close` removes the session directory.
4. **A pidfile**, so `close` can verify the daemon died and end it if not.
5. `close` on a session that does not exist still succeeds — it is what an agent calls in a cleanup path.

## Global Constraints

- Zero runtime dependencies, Bun-native APIs only, no new devDependency.
- `bun run typecheck` (tsc) is the real gate; `bun test` strips types. Run both.
- **Never signal a pid without confirming the process is ours.** The ownership check is the one thing in this change that can damage something outside bowser.
- Every commit message ends with the two attribution lines used in this repo.
- After any e2e run, `pgrep -fl "daemon/main|--daemon"` must show nothing of ours.

---

### Task 1: the daemon records its pid

**Files:** `src/daemon/client.ts` (`pidPath`), `src/daemon/server.ts` (`startDaemon`, the `shutdown` handler), `tests/daemon.test.ts`

- [ ] **Step 1: `pidPath`, beside `socketPath`**

```ts
export function pidPath(session: string): string {
  return join(sessionsRoot(), session, "pid");
}
```

- [ ] **Step 2: write it at startup, remove it on shutdown**

In `startDaemon`, next to the stale-socket cleanup:

```ts
  await Bun.write(pidPath(session), String(process.pid));
```

In the `shutdown` handler in `handlers`, inside the existing `setTimeout` and before `process.exit(0)`, remove it — a pidfile outliving its process is exactly the stale state this ticket is about:

```ts
      try { await unlink(pidPath(session)); } catch {}
```

`shutdown`'s handler does not currently receive the session name. Give `createHandler` what it needs rather than reaching for a module global; the `state` op already showed the shape for threading per-daemon context.

- [ ] **Step 3: test**

```ts
test("the daemon writes its pid and removes it on shutdown", async () => { … });
```

Assert the file contains a number equal to the live process, and is gone after shutdown.

- [ ] **Step 4:** `bun run typecheck && bun test`, then commit.

---

### Task 2: one liveness predicate, and `list` uses it

**Files:** `src/commands/navigation.ts`, `tests/commands.test.ts`

- [ ] **Step 1: the predicate**

```ts
/** A session is live when its daemon answers. The socket file alone is not
 *  enough — a stale socket outlives a crashed daemon — and a pid alone is not
 *  either, since an orphan holds no socket. `ping` is on the urgent lane, so a
 *  busy daemon still answers and reads as live, which is correct. */
async function isLive(ctx: CommandContext, session: string): Promise<boolean> {
  try {
    const c = await connector(ctx)(session, { spawn: false });
    try { await c.request("ping"); return true; } finally { c.close(); }
  } catch { return false; }
}
```

- [ ] **Step 2: `cmdList` filters**

Probe the directories concurrently — `Promise.all` over the names — so the command stays fast when several sessions exist.

- [ ] **Step 3: tests**

- `list` omits a directory with no socket (**must fail against today's code**).
- `list` includes a session whose fake daemon answers `ping`.
- `list --json` returns the same filtered set.

- [ ] **Step 4:** typecheck, tests, commit.

---

### Task 3: `close` tells the truth and leaves nothing

**Files:** `src/commands/navigation.ts` (`closeOne`), `tests/commands.test.ts`

**This is the task the ticket exists for. Read the spec's reproduction before starting.**

- [ ] **Step 1: the ownership guard, written first and tested first**

```ts
/** True when `pid` is one of our daemons for `session`. Never signal a pid
 *  without this: pids are reused, and killing a stranger's process because a
 *  stale file named it would be far worse than leaking one of ours. */
async function isOurDaemon(pid: number, session: string): Promise<boolean> {
  const out = await new Response(
    Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe" }).stdout,
  ).text();
  return out.includes(session) && (out.includes("--daemon") || out.includes("daemon/main"));
}
```

Test the refusals before the acceptances: a pid whose command line does not name the session, and a pid that does not exist, must both return false.

- [ ] **Step 2: the new `closeOne` flow**

1. Read the pidfile, if any.
2. Try connect + `shutdown` as today. Success means the daemon is exiting.
3. Unlink the socket.
4. If a pid was recorded, poll up to ~2 s for it to disappear.
5. If it is still alive **and** `isOurDaemon` says it is ours, send `SIGTERM`, then poll again.
6. If it is still alive after that, **throw** — `close` must not claim success.
7. Remove the session directory (`rm -rf` on the session dir).
8. Report what happened.

A session with no socket and no pidfile is decision 5's case: nothing to do, succeed quietly.

- [ ] **Step 3: tests**

- `close` removes the session directory.
- `close` throws when the process cannot be confirmed gone (fake `isOurDaemon`/kill path).
- `close` on a name with no directory still succeeds.
- `close --all` closes several and leaves no directories.

- [ ] **Step 4:** typecheck, tests, commit.

---

### Task 4: the reproduction as a test, docs, gate, PR

**Files:** `tests/daemon.test.ts` or a new integration test, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: the integration test**

The spec's reproduction, turned into a test: open a real session, delete its socket, `close`, and assert **both** that the command fails or reports the kill **and** that no daemon process for that session survives. Guard it like the other tests that need a real browser.

- [ ] **Step 2: README**

The `list` row says "List sessions". It must say live sessions. The `close` row should say the session directory is removed.

- [ ] **Step 3: CHANGELOG**

Under `### Fixed`: `close` could report success while leaving a browser process running, with the mechanism. Under `### Changed`: `list` shows only live sessions; `close` removes the session directory.

- [ ] **Step 4: full gate**

```bash
bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
pgrep -fl "daemon/main|--daemon"     # must show nothing of ours
```

Then push and open the PR, ending with the repo's standard attribution block.

---

## Self-review against the spec

- **Criterion 1** (`list` shows only live) → Task 2.
- **Criterion 2** (the orphan is ended) → Task 3, steps 4-6; proven by Task 4's integration test.
- **Criterion 3** (non-zero when it cannot confirm) → Task 3, step 6.
- **Criterion 4** (directory gone) → Task 3, step 7.
- **Criterion 5** (no daemon after an e2e run) → Task 4, step 4.
- **Criterion 6** (typecheck, tests, e2e) → Task 4, step 4.
- **Boundary honoured:** the ownership check is written and tested before anything can send a signal (Task 3, step 1).
