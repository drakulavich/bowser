# Dogfooding Bug Fixes (issue #7) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 bugs from the WebKit dogfooding report (#7): serialize daemon operations (fixes the evaluate-race hangs #1/#3/#4), add `close [name]`/`close --all` (#6/#7), and fail-loud + workaround the WebKit screenshot/navigate gaps (#2/#5).

**Architecture:** Cluster A introduces two pure primitives in a new `src/serialize.ts` (a promise-chain mutex + a timeout wrapper) wired into the daemon's request dispatch. Cluster C reshapes `cmdClose` to take `{ name, all }`. Cluster B adds fail-loud guards (`isLikelyPng` for screenshots; about:blank detection for navigate) plus runtime investigation for a real workaround.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

Reference spec: `docs/superpowers/specs/2026-06-04-dogfooding-bug-fixes-design.md`.

---

## File Structure

- **Create** `src/serialize.ts` — `createSerializer()` (promise-chain mutex) + `withTimeout()`. Pure, no I/O.
- **Create** `tests/serialize.test.ts` — unit tests for both primitives.
- **Modify** `src/daemon.ts` — wire serializer + timeout into `startDaemon`'s `Bun.listen` data handler; add `opTimeoutMs()`.
- **Modify** `src/cli/schemas.ts` — `close` gets an optional positional + `--all` flag.
- **Modify** `src/cli.ts` — pass `{ name, all }` to `cmdClose`.
- **Modify** `src/commands.ts` — reshape `cmdClose`; add `closeOne`/`closeAll`; add about:blank guard to `cmdOpen`/`cmdGoto`.
- **Modify** `src/browser.ts` — add `isLikelyPng()`; validate screenshot bytes; investigate navigate load-wait.
- **Modify** `tests/commands.test.ts`, `tests/compat.test.ts` — close + navigate-guard coverage.
- **Modify** `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md`, `AGENTS.md` — docs.

---

## Task 1: Serializer + timeout primitives

**Files:**
- Create: `src/serialize.ts`
- Test: `tests/serialize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/serialize.test.ts`:

```ts
// Unit tests for the daemon's request-serialization primitives.
import { describe, expect, test } from "bun:test";
import { createSerializer, withTimeout } from "../src/serialize.ts";

describe("createSerializer", () => {
  test("runs tasks strictly one at a time, in submission order", async () => {
    const serialize = createSerializer();
    const events: string[] = [];
    const mk = (id: string, delay: number) => () =>
      new Promise<void>((r) => {
        events.push(`start:${id}`);
        setTimeout(() => { events.push(`end:${id}`); r(); }, delay);
      });
    // A is slow, B is fast — B must NOT start until A has ended.
    const a = serialize(mk("A", 30));
    const b = serialize(mk("B", 0));
    await Promise.all([a, b]);
    expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  test("a rejecting task does not break the chain", async () => {
    const serialize = createSerializer();
    const boom = serialize(() => Promise.reject(new Error("boom")));
    await expect(boom).rejects.toThrow("boom");
    expect(await serialize(() => Promise.resolve("ok"))).toBe("ok");
  });

  test("returns the task's resolved value", async () => {
    const serialize = createSerializer();
    expect(await serialize(() => Promise.resolve(42))).toBe(42);
  });
});

describe("withTimeout", () => {
  test("resolves a fast promise", async () => {
    expect(await withTimeout(Promise.resolve("v"), 1000, "op")).toBe("v");
  });

  test("rejects a slow promise with the label in the message", async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 5, "evaluate")).rejects.toThrow(/operation 'evaluate' timed out/);
  });

  test("passes the promise through unchanged when ms <= 0", async () => {
    expect(await withTimeout(Promise.resolve("v"), 0, "op")).toBe("v");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/serialize.test.ts`
Expected: FAIL — `src/serialize.ts` does not exist / exports missing.

- [ ] **Step 3: Implement**

Create `src/serialize.ts`:

```ts
// Primitives for the daemon: run browser operations one at a time (the single
// Bun.WebView can't handle a second evaluate() while one is pending), and bound
// each operation so a wedged WebKit call surfaces as an error instead of hanging.

/** Returns a function that queues async work so each call runs strictly after
 *  the previous one settles — one operation at a time, across all callers. */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task); // run regardless of the previous outcome
    tail = run.catch(() => {});        // a rejection must not break the chain
    return run;
  };
}

/** Reject with a clear, labelled error if `p` does not settle within `ms`.
 *  When `ms <= 0` the timeout is disabled and `p` is returned unchanged. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`operation '${label}' timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/serialize.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/serialize.ts tests/serialize.test.ts
git commit -m "feat: add daemon request serializer and timeout primitives

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire serialization + timeout into the daemon

**Files:**
- Modify: `src/daemon.ts` (import, `opTimeoutMs`, `startDaemon` dispatch)

No new unit test: `startDaemon` needs a real `Bun.WebView`. The primitives are unit-tested in Task 1; this wiring is verified by build + a manual concurrency repro (Step 4).

- [ ] **Step 1: Add the import**

In `src/daemon.ts`, add near the other imports (the `openBrowser` import is around line 16):

```ts
import { createSerializer, withTimeout } from "./serialize.ts";
```

- [ ] **Step 2: Add the timeout helper**

In `src/daemon.ts`, add this near the top-level helpers (e.g. just above `export async function startDaemon`):

```ts
/** Per-operation timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}
```

- [ ] **Step 3: Serialize the dispatch**

In `startDaemon`, create the serializer once before `Bun.listen` (just after the `handle` function is defined, before the `Bun.listen({...})` call):

```ts
  const serialize = createSerializer();
```

Then in the `Bun.listen` `data` handler, replace the existing dispatch:

```ts
          handle(req).then((res) => {
            socket.write(JSON.stringify(res) + "\n");
          });
```

with:

```ts
          serialize(() => withTimeout(handle(req), opTimeoutMs(), req.op)).then(
            (res) => {
              socket.write(JSON.stringify(res) + "\n");
            },
            (err) => {
              // handle() catches its own errors; this path is for timeouts.
              const msg = err instanceof Error ? err.message : String(err);
              socket.write(JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
            },
          );
```

- [ ] **Step 4: Verify build + concurrency repro**

Run: `bun build src/cli.ts --compile --outfile /tmp/bowser-task2 && echo BUILD_OK`
Expected: BUILD_OK.

Run the full unit suite: `bun test` → expect 0 failures.

Manual concurrency repro (macOS; proves the race is gone):

```bash
unset BOWSER_BACKEND  # or set =webkit to force the native backend the report used
bun run src/cli.ts open https://example.com --session racetest
# Fire two snapshots at the SAME daemon concurrently — previously raced with
# "evaluate() is already pending"; now they serialize.
( bun run src/cli.ts snapshot --session racetest & \
  bun run src/cli.ts snapshot --session racetest & wait ) 2>&1 | sort | uniq -c
bun run src/cli.ts close --session racetest
```
Expected: both invocations print the aria-tree YAML; **no** "already pending" error.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts
git commit -m "fix: serialize daemon operations with a per-op timeout

Concurrent ops on the single Bun.WebView raced ('evaluate already pending')
or wedged into an indefinite hang (issue #7: #1/#3/#4). Run handle() through
a promise-chain serializer and bound each op with BOWSER_OP_TIMEOUT_MS.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `close [name]` positional (#6)

**Files:**
- Modify: `src/cli/schemas.ts:13`
- Modify: `src/cli.ts:64`
- Modify: `src/commands.ts` (`cmdClose`, ~line 217)
- Test: `tests/commands.test.ts`, `tests/compat.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/commands.test.ts`, inside the existing `describe("close", ...)` block (around line 225), add:

```ts
  test("closes the session named by the positional, not --session default", async () => {
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { name: "dog1" });
    expect(out).toContain("closed session 'dog1'");
  });
```

(`ctx()` defaults the session to whatever the helper uses — the point is the
returned message names `dog1`, the positional, not that default.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts -t "closes the session named by the positional"`
Expected: FAIL — `cmdClose` takes no second argument; TypeScript error or message names the default session.

- [ ] **Step 3: Implement**

In `src/commands.ts`, replace the whole `cmdClose` function (currently lines ~217–242) with:

```ts
export async function cmdClose(
  ctx: CommandContext,
  opts: { name?: string; all?: boolean } = {},
): Promise<string> {
  if (opts.all) return closeAll(ctx);
  return closeOne(ctx, opts.name ?? ctx.session);
}

async function closeOne(ctx: CommandContext, session: string): Promise<string> {
  const prev = await loadState(session);

  // Try to gracefully shut down the daemon. If it's not running, that's fine.
  try {
    const client = await connector(ctx)(session, { spawn: false });
    try {
      await client.request("shutdown");
    } finally {
      client.close();
    }
  } catch {
    // no daemon; that's ok
  }

  // Remove the socket file.
  try {
    await unlink(socketPath(session));
  } catch {}

  await saveState({ ...emptyState(prev?.name ?? session), updatedAt: Date.now() });

  return ctx.json
    ? JSON.stringify({ ok: true, session })
    : `closed session '${session}'`;
}
```

(`closeAll` is added in Task 4. For this task, add a temporary stub so the file
compiles — Task 4 replaces it:

```ts
async function closeAll(ctx: CommandContext): Promise<string> {
  throw new Error("close --all not implemented yet");
}
```)

In `src/cli/schemas.ts`, change line 13 from:

```ts
    { name: "close",       positional: [],                                                   flags: [] },
```

to:

```ts
    { name: "close",       positional: [{ name: "session", required: false }],               flags: [{ name: "all", kind: "boolean" }] },
```

In `src/cli.ts`, change line 64 from:

```ts
    case "close":      return cmdClose(ctx);
```

to:

```ts
    case "close":      return cmdClose(ctx, { name: p0, all: Boolean(args.flags.all) });
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/commands.test.ts -t "close"`
Expected: PASS — both the existing close test and the new positional test.

- [ ] **Step 5: Add a parse test**

In `tests/compat.test.ts`, add `["close", "dog1"]` and `["close", "--all"]` to the table of invocations that must parse without error (match the file's existing table style).

Run: `bun test tests/compat.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts src/cli.ts src/cli/schemas.ts tests/commands.test.ts tests/compat.test.ts
git commit -m "fix: close [name] honors the positional session (#6)

bowser close dog1 silently closed 'default' because close had no positional.
Add an optional [session] positional and report the session actually closed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `close --all` (#7)

**Files:**
- Modify: `src/commands.ts` (replace the `closeAll` stub)
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/commands.test.ts`, inside `describe("close", ...)`, add:

```ts
  test("--all closes every session under the sessions root", async () => {
    // Seed two sessions on disk (saveState creates ~/.bowser/sessions/<name>/).
    await saveState({ name: "a", url: "", title: "", refs: [], updatedAt: Date.now() });
    await saveState({ name: "b", url: "", title: "", refs: [], updatedAt: Date.now() });
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { all: true });
    expect(out).toContain("a");
    expect(out).toContain("b");
  });
```

(Tests already redirect `process.env.HOME` to a tmp dir, so the sessions root is
isolated.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts -t "all closes every session"`
Expected: FAIL — `closeAll` stub throws "not implemented yet".

- [ ] **Step 3: Implement**

In `src/commands.ts`, replace the `closeAll` stub from Task 3 with:

```ts
async function closeAll(ctx: CommandContext): Promise<string> {
  const root = join(homedir(), ".bowser", "sessions");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    // no sessions root; nothing to close
  }
  for (const name of names) {
    try {
      await closeOne(ctx, name);
    } catch {
      // best-effort: keep closing the rest
    }
  }
  return ctx.json
    ? JSON.stringify({ ok: true, closed: names })
    : names.length
      ? `closed ${names.length} session(s): ${names.join(", ")}`
      : "no sessions to close";
}
```

(`join`, `homedir`, and `readdir` are already imported in `src/commands.ts` — see
lines 15–17. No new imports needed.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/commands.test.ts -t "close"`
Expected: PASS (all close tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts tests/commands.test.ts
git commit -m "feat: close --all closes every session (#7)

No bulk close existed; dogfooding leaked 383 sessions. close --all enumerates
~/.bowser/sessions and shuts each down.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Screenshot fail-loud guard + investigation (#2)

**Files:**
- Modify: `src/browser.ts` (add `isLikelyPng`; validate in `screenshot`)
- Test: `tests/backend.test.ts` (unit test `isLikelyPng`)

The guaranteed deliverable is the validation guard (never write a broken file).
A real workaround is attempted via investigation (Step 5) but is best-effort.

- [ ] **Step 1: Write the failing test**

In `tests/backend.test.ts`, add the import for `isLikelyPng` to the existing
`../src/browser.ts` import, then append:

```ts
describe("isLikelyPng", () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("accepts a buffer with the PNG signature and plausible length", () => {
    const buf = new Uint8Array([...PNG_SIG, ...new Array(40).fill(0)]);
    expect(isLikelyPng(buf)).toBe(true);
  });

  test("rejects a 7-byte stub (the dogfooding bug)", () => {
    expect(isLikelyPng(new Uint8Array(7))).toBe(false);
  });

  test("rejects an empty buffer", () => {
    expect(isLikelyPng(new Uint8Array(0))).toBe(false);
  });

  test("rejects correct length but wrong magic bytes", () => {
    expect(isLikelyPng(new Uint8Array(64))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/backend.test.ts -t "isLikelyPng"`
Expected: FAIL — `isLikelyPng` is not exported.

- [ ] **Step 3: Implement `isLikelyPng`**

In `src/browser.ts`, add near the other exported helpers (e.g. above `detectChromium`):

```ts
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Cheap sanity check that `bytes` is a real PNG: the 8-byte signature plus a
 *  plausible minimum length (a 1x1 PNG is ~67 bytes; the dogfooding bug wrote a
 *  7-byte stub). Used to fail loud instead of saving a broken screenshot. */
export function isLikelyPng(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return false; // 8 sig + 25-byte IHDR chunk floor
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/backend.test.ts -t "isLikelyPng"`
Expected: PASS (4 tests).

- [ ] **Step 5: Investigate the WebKit screenshot (systematic-debugging) + wire the guard**

Use the systematic-debugging skill. First reproduce on the WebKit backend:

```bash
BOWSER_BACKEND=webkit bun run src/cli.ts open https://example.com --session shot
BOWSER_BACKEND=webkit bun run src/cli.ts screenshot --filename=/tmp/shot.png --session shot
wc -c /tmp/shot.png   # bug: ~7 bytes
BOWSER_BACKEND=webkit bun run src/cli.ts close --session shot
```

Investigate whether awaiting a paint/load before capture yields real bytes (e.g.
inject `await view.evaluate('new Promise(r => requestAnimationFrame(() => r(1)))')`
before `view.screenshot()`). If a workaround produces a valid PNG, apply it.

Regardless of the investigation outcome, wire the guard. In `src/browser.ts`,
update the `screenshot` method (currently ~lines 173–185) to validate before
writing/returning:

```ts
    screenshot: async ({ selector: _sel, path }) => {
      // Bun.WebView exposes screenshot() returning base64 PNG.
      // Element-bounded screenshots are not supported in v1; we return full-page either way.
      // (Selector reserved for a future CDP path.)
      const data = await (view as { screenshot?: () => Promise<string> }).screenshot?.();
      if (!data) throw new Error('screenshot: not supported by this Bun.WebView');
      const buf = Buffer.from(String(data), 'base64');
      if (!isLikelyPng(buf)) {
        throw new Error(
          'screenshot: empty/invalid image from the webkit backend — use BOWSER_BACKEND=chrome for screenshots',
        );
      }
      if (path) {
        await Bun.write(path, buf);
        return undefined;
      }
      return String(data);
    },
```

Re-run the repro: expect either a valid PNG (`wc -c` ≫ 33, `file` reports PNG) if a
workaround was found, or a clear non-zero-exit error and **no** broken file written.

Run: `bun test` → expect 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/backend.test.ts
git commit -m "fix: validate webkit screenshots; never write a broken PNG (#2)

The webkit backend produced a 7-byte stub. Add isLikelyPng() and reject
empty/invalid image data with a clear error (use BOWSER_BACKEND=chrome)
instead of saving a broken file. <note workaround here if one was found>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Navigate about:blank guard + investigation (#5)

**Files:**
- Modify: `src/commands.ts` (`cmdOpen` ~line 53, `cmdGoto`) — fail-loud guard
- Modify: `src/browser.ts` (`navigate`) — investigation/workaround
- Test: `tests/commands.test.ts`

Guaranteed deliverable: a real URL that ends on `about:blank` is reported as an
error, not a false success. Workaround (a load-wait in `navigate`) is best-effort.

- [ ] **Step 1: Write the failing test**

In `tests/commands.test.ts`, add (near the open/goto tests):

```ts
  test("goto errors when a real URL ends on about:blank", async () => {
    const c = fakeClient({ state: () => ({ url: "about:blank", title: "X" }) });
    await expect(
      cmdGoto({ ...ctx(), connect: async () => c }, "https://example.com/?q=1"),
    ).rejects.toThrow(/did not load/i);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts -t "ends on about:blank"`
Expected: FAIL — `cmdGoto` currently returns success with `url: "about:blank"`.

- [ ] **Step 3: Implement the guard**

In `src/commands.ts`, add a shared helper near `cmdOpen`/`cmdGoto`:

```ts
/** A real navigation that lands on about:blank means the page never committed
 *  (a WebKit-backend quirk seen with query-string URLs). Fail loud rather than
 *  report a false success. */
function assertNavigated(requested: string, finalUrl: string): void {
  if (requested && requested !== "about:blank" && finalUrl === "about:blank") {
    throw new Error(`navigate: page did not load ${requested} (ended on about:blank)`);
  }
}
```

In `cmdGoto`, after `const state = (await c.request("state")) ...` and before
`saveState`, add:

```ts
    assertNavigated(url, state.url);
```

In `cmdOpen`, after the `const state = ...` line and before `saveState`, add:

```ts
    if (url) assertNavigated(url, state.url);
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/commands.test.ts -t "about:blank"`
Expected: PASS. Also run `bun test tests/commands.test.ts -t "open"` and `-t "goto"`
to confirm existing open/goto tests still pass (they use real-looking URLs/state).

- [ ] **Step 5: Investigate the navigate quirk (systematic-debugging) + optional workaround**

Use systematic-debugging. Reproduce on WebKit:

```bash
BOWSER_BACKEND=webkit bun run src/cli.ts open 'https://www.w3schools.com/html/tryit.asp?filename=tryhtml_elem_select' --session nav
BOWSER_BACKEND=webkit bun run src/cli.ts close --session nav
```

Investigate whether `view.navigate(url)` resolves before the page commits. If so,
add a load-wait in `src/browser.ts` `navigate` (currently `navigate: (url) => view.navigate(url)` ~line 142) — e.g. poll `view.url` until it leaves `about:blank` (bounded, a few hundred ms), or await a Bun.WebView load signal if one exists. Apply the workaround if it makes the query-param URL load correctly; otherwise the Step 3 guard ensures we fail loud rather than lie.

Run: `bun test` → expect 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/commands.ts src/browser.ts tests/commands.test.ts
git commit -m "fix: error when a real navigation ends on about:blank (#5)

Query-string URLs sometimes resolved to about:blank (title correct, URL lost)
on the webkit backend, reported as success. Detect and fail loud.
<note load-wait workaround here if one was found>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Documentation + issue update

**Files:**
- Modify: `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md`, `AGENTS.md`
- Update: GitHub issue #7 (comment)

- [ ] **Step 1: README.md**

Document the close changes and the timeout knob. In the command reference (find the
`close` row / session section), document:

```markdown
- `close [name]` — close a session (defaults to `--session`; a positional name overrides it)
- `close --all` — close every session
```

And near the environment-variable docs, add:

```markdown
- `BOWSER_OP_TIMEOUT_MS` — per-operation timeout in the daemon (default `30000`; `0` disables). Guards against a wedged WebKit call hanging the CLI.
```

If the screenshot/navigate investigations (Tasks 5–6) concluded "upstream", add a
short **Known WebKit limitations** note pointing to the filed upstream issue(s).

- [ ] **Step 2: skills/bowser/SKILL.md**

Add `close [name]` / `close --all` to the command reference and a one-line note on
`BOWSER_OP_TIMEOUT_MS`, matching the file's existing style.

- [ ] **Step 3: CHANGELOG.md**

Add an `## [Unreleased]` section (or the next version) summarizing: daemon op
serialization + timeout (#1/#3/#4), `close [name]`/`close --all` (#6/#7), screenshot
validation (#2), navigate about:blank guard (#5).

- [ ] **Step 4: AGENTS.md**

Under "## Conventions" or "## Gotchas", add:

```markdown
- **Daemon serializes operations.** `startDaemon` runs every request through a
  promise-chain serializer (`src/serialize.ts`) with a `BOWSER_OP_TIMEOUT_MS`
  budget — the single `Bun.WebView` can't handle a concurrent `evaluate()`. Don't
  reintroduce the bare `handle(req).then(...)` dispatch.
```

- [ ] **Step 5: Commit**

```bash
git add README.md skills/bowser/SKILL.md CHANGELOG.md AGENTS.md
git commit -m "docs: close [name]/--all, BOWSER_OP_TIMEOUT_MS, webkit notes (#7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Update issue #7**

Post a comment on issue #7 summarizing per-bug outcomes (fixed / fixed-with-guard /
upstream-filed), linking the PR and any upstream issues. Do this via `gh issue comment 7`.

---

## Done-When

- `bun test` green, including `tests/serialize.test.ts` and the new close/screenshot/navigate tests.
- Concurrency repro: two concurrent ops on one session no longer raise "evaluate already pending"; a wedged op times out with a clear error instead of hanging.
- `bowser close dog1` closes `dog1`; `bowser close --all` closes every session.
- Screenshot on WebKit either yields a valid PNG (if a workaround was found) or errors clearly — never a 7-byte file.
- A real URL that lands on about:blank errors instead of reporting success.
- Docs updated; issue #7 commented with outcomes.
