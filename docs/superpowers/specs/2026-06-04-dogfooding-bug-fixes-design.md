# Dogfooding bug fixes (issue #7)

**Status:** approved (design)
**Date:** 2026-06-04
**Source:** GitHub issue #7 — "Dogfooding Report: 10-scenario WebKit battle test"

## Problem

A WebKit-backend dogfooding session (macOS, Bun 1.3.13) surfaced 7 bugs. They
collapse into three clusters by root cause:

| Cluster | Bugs | Root cause |
| --- | --- | --- |
| **A — evaluate serialization** | #1 sessionStorage hang, #3 "evaluate already pending", #4 reload+snapshot hang | The daemon dispatches requests without serializing them (`src/daemon.ts:154`, `handle(req).then(...)`). Concurrent operations on the single `Bun.WebView` (especially the WebKit backend) collide — a second `evaluate` while one is pending throws "Invalid state: an evaluate() is already pending", and a wedged call makes every later op hang. |
| **B — WebKit feature gaps** | #2 screenshot 7-byte PNG, #5 query-param URL → about:blank | Bun.WebView WebKit-backend behavior; needs runtime investigation, may be upstream. |
| **C — CLI/session bugs** | #6 `close <name>` closes the wrong session, #7 no bulk close (session leak) | `close` schema has no positional, so the name is ignored; no `--all`. |

Note #1 is **not** sessionStorage-specific: localStorage and sessionStorage share
identical code (`storageScript` + `evaluate`). sessionStorage "hung" because it ran
later in the sequence, behind a wedged evaluate from cluster A.

## Goal

Fix all 7 bugs in one effort, sequenced A → C → B (highest leverage and certainty
first; B is investigate-then-fix and may downgrade to a documented upstream
limitation).

## Cluster A — serialize daemon operations

**Fix:** introduce two small, pure, independently-tested primitives and wire them
into the daemon's request dispatch:

1. **A serializer (promise-chain mutex).** A factory returning a function that
   queues async work so each call runs strictly after the previous one settles —
   one operation at a time across *all* socket connections.

   ```ts
   // src/serialize.ts
   export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
     let tail: Promise<unknown> = Promise.resolve();
     return (task) => {
       const run = tail.then(task, task); // run regardless of prior outcome
       tail = run.catch(() => {});        // never let a rejection break the chain
       return run;
     };
   }
   ```

2. **A timeout wrapper.** Rejects with a clear error if an operation does not
   settle within a bound, so a wedged WebKit call surfaces instead of hanging.

   ```ts
   // src/serialize.ts
   export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
     if (!(ms > 0)) return p;
     return new Promise<T>((resolve, reject) => {
       const t = setTimeout(() => reject(new Error(`operation '${label}' timed out after ${ms}ms`)), ms);
       p.then(
         (v) => { clearTimeout(t); resolve(v); },
         (e) => { clearTimeout(t); reject(e); },
       );
     });
   }
   ```

**Wiring (`src/daemon.ts`, `startDaemon`):** create one serializer per daemon;
in the `Bun.listen` data handler, replace `handle(req).then(...)` with

```ts
serialize(() => withTimeout(handle(req), opTimeoutMs(), req.op))
  .then((res) => socket.write(JSON.stringify(res) + "\n"))
  .catch((err) => socket.write(JSON.stringify({ id: req.id, ok: false, error: String(err?.message ?? err) }) + "\n"));
```

The timeout budget comes from `opTimeoutMs()` = `BOWSER_OP_TIMEOUT_MS` env (default
`30000`; `0`/unset-to-disable handled by `withTimeout`'s `ms > 0` guard — default
is 30000 so the guard passes).

**Exit code:** a timeout is a runtime error (exit 2). The existing `import.meta.main`
regex in `src/cli.ts` already maps non-user-error messages to exit 2; "operation
'...' timed out" is not in the user-error set, so it falls through to 2. No regex
change needed.

**Tests (`tests/serialize.test.ts`, new):**
- `createSerializer` runs tasks in submission order and never overlaps (interleave a
  shared counter / timestamps; assert strict ordering even when later tasks are
  faster).
- A rejecting task does not break the chain — the next task still runs.
- `withTimeout` resolves a fast promise, rejects a slow one with the `label` in the
  message, and passes through when `ms <= 0`.

Daemon-level integration is covered by the existing real-WebView e2e (optionally
extend an e2e to chain `click` → `snapshot` in one session and assert no
"already pending").

## Cluster C — `close` ergonomics

**`close [name]` positional (#6):**
- `src/cli/schemas.ts`: change the `close` entry to `positional: ["session"]`
  (optional — the parser already allows fewer args), add `flags: ["all"]`.
- `src/cli.ts`: resolve the close target as `p0 ?? ctx.session` and pass it; the
  reported message names the session actually closed.

**`close --all` (#7):**
- `cmdClose` gains an `all` path: enumerate `~/.bowser/sessions/` (same `readdir`
  as `cmdList`), and for each session run the existing shutdown sequence (connect
  with `spawn:false` → `shutdown` → unlink socket → clear state). Report the count
  and names; tolerate already-dead daemons.

**Signature:** `cmdClose(ctx, opts?: { name?: string; all?: boolean })`. `cli.ts`
passes `{ name: p0, all: args.all }`. Single-session path uses `opts.name ?? ctx.session`.

**Tests (`tests/commands.test.ts`):**
- `close <name>` closes the named session and the message/JSON names it (not "default").
- `close --all` iterates every session under a tmp HOME and closes each.
- `tests/compat.test.ts`: `close dog1` and `close --all` parse without error.

## Cluster B — WebKit feature gaps (investigate-then-fix)

Policy (confirmed): attempt an in-bowser workaround; if the root cause is genuinely
upstream (Bun/WebKit), make the command **fail loud** (no broken artifact / no
silent about:blank), **document** the limitation, and **file an upstream issue**.

**#2 screenshot (7-byte PNG):**
- Investigate via systematic-debugging: capture what `view.screenshot()` returns on
  WebKit; test whether awaiting load / a paint tick before capture yields real data.
- Workaround if found. Otherwise add a **PNG validation** guard in
  `browser.screenshot`: reject data that isn't a valid PNG (8-byte signature
  `89 50 4E 47 0D 0A 1A 0A` and a plausible length) with
  `screenshot: empty/invalid image from webkit backend — use BOWSER_BACKEND=chrome`.
  Never write a broken file.
- Unit-test the PNG-validation helper (valid PNG header passes; 7-byte/garbage fails).

**#5 query-param URL → about:blank:**
- Investigate whether `view.navigate(url)` resolves before the page commits, or the
  query string is mishandled.
- Workaround: after navigate, await load and verify the final URL; if a real URL was
  requested but the page is on `about:blank`, retry once, else **error**
  (`navigate: page did not load <url> (ended on about:blank)`) instead of reporting
  success.
- e2e assertion that a query-param URL does not end on about:blank (may be marked
  `skip` with a comment + upstream link if confirmed upstream).

## Cross-cutting

- **Docs:** README + `skills/bowser/SKILL.md` for `close [name]` / `close --all` and
  `BOWSER_OP_TIMEOUT_MS`; document any confirmed WebKit limitation. `CHANGELOG.md`
  entry. `AGENTS.md`: note the daemon serializer + timeout.
- **Issue #7:** comment with per-bug outcomes; link any upstream issues filed.

## Out of scope

- Element-bounded screenshots (already a documented v1 limitation).
- Reworking the daemon transport (newline-delimited JSON over unix socket stays).
- Any change to the chrome backend's behavior.

## Testing summary

- `tests/serialize.test.ts` (new) — serializer ordering/isolation + `withTimeout`.
- `tests/commands.test.ts` — `close <name>`, `close --all`, screenshot PNG-validation.
- `tests/compat.test.ts` — `close dog1`, `close --all` parse.
- e2e (gated) — chained click→snapshot no-race; query-param navigate not about:blank.
- Full `bun test` green; build compiles.
