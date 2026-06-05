# Screenshot Blob Fix + PR #8 Feedback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix screenshots for real (decode the `Blob` `view.screenshot()` returns; write the file CLI-side), address PR #8 review (shutdown bypasses the serializer; `socketPath` reuses `sessionsRoot()`), and correct the now-wrong #2 "upstream limitation" record.

**Architecture:** A pure `pngBytesFrom()` decodes the Blob/base64; `browser.screenshot()` returns base64 of real PNG bytes; `cmdScreenshot` writes the file in the CLI process (default `screenshot-<session>.png`). The daemon dispatch special-cases `shutdown` to skip serialization. `socketPath` delegates to `sessionsRoot()`.

**Tech Stack:** Bun, TypeScript, `bun:test`.

Reference spec: `docs/superpowers/specs/2026-06-05-screenshot-blob-and-pr-feedback-design.md`.

**Shared test fixture (valid 1×1 PNG, base64):**
```
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==
```
Decodes to ~68 bytes starting with the PNG signature — passes `isLikelyPng`.

---

## File Structure

- **Modify** `src/browser.ts` — add `pngBytesFrom()`; rewrite `screenshot` to return base64; change the `Browser.screenshot` signature.
- **Modify** `src/daemon.ts` — screenshot op calls `browser.screenshot()` (no args); `shutdown` bypasses the serializer; `socketPath` uses `sessionsRoot()`.
- **Modify** `src/commands.ts` — add `nextAvailablePath()`; `cmdScreenshot` writes the file CLI-side with an auto-incrementing default name.
- **Create** `tests/screenshot.test.ts` — `pngBytesFrom` unit tests.
- **Modify** `tests/commands.test.ts` — update the two screenshot tests + `fakeClient`.
- **Modify** `tests/daemon.test.ts` — `socketPath` honors `process.env.HOME`.
- **Modify** `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md`, `AGENTS.md` — correct #2.

---

## Task 1: `pngBytesFrom()` pure helper

**Files:**
- Modify: `src/browser.ts` (add exported helper near `isLikelyPng`)
- Test: `tests/screenshot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/screenshot.test.ts`:

```ts
// Unit tests for decoding what Bun.WebView.screenshot() returns (a Blob).
import { describe, expect, test } from "bun:test";
import { pngBytesFrom } from "../src/browser.ts";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("pngBytesFrom", () => {
  test("decodes a Blob to its bytes", async () => {
    const original = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const blob = new Blob([original], { type: "image/png" });
    const out = await pngBytesFrom(blob);
    expect(out).toEqual(original);
  });

  test("decodes a base64 string to its bytes", async () => {
    const original = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const out = await pngBytesFrom(PNG_B64);
    expect(out).toEqual(original);
  });

  test("the decoded bytes start with the PNG signature", async () => {
    const out = await pngBytesFrom(PNG_B64);
    expect([...out.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/screenshot.test.ts`
Expected: FAIL — `pngBytesFrom` not exported.

- [ ] **Step 3: Implement**

In `src/browser.ts`, add near `isLikelyPng` (above `detectChromium`):

```ts
/** Decode whatever Bun.WebView.screenshot() returns into raw PNG bytes.
 *  Current Bun returns a Blob (type image/png); we also accept a base64 string
 *  defensively in case the API shape changes. */
export async function pngBytesFrom(data: Blob | string): Promise<Uint8Array> {
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
  return new Uint8Array(await data.arrayBuffer());
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/screenshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts tests/screenshot.test.ts
git commit -m "feat: add pngBytesFrom to decode the Blob from view.screenshot()

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `browser.screenshot()` returns base64; daemon op drops `path`

**Files:**
- Modify: `src/browser.ts` (`Browser.screenshot` signature at line 123; `screenshot` method at ~lines 192-212)
- Modify: `src/daemon.ts` (`case "screenshot"` at ~lines 105-111)

No new unit test: `screenshot` needs a real WebView. The decode is covered by Task 1; this wiring is verified by build + the live screenshot in Task 3's manual check and Task 6.

- [ ] **Step 1: Change the `Browser` interface**

In `src/browser.ts`, change line 123 from:

```ts
  screenshot(opts: { selector?: string; path?: string }): Promise<string | undefined>;
```

to:

```ts
  screenshot(): Promise<string>; // base64-encoded PNG (full page)
```

- [ ] **Step 2: Rewrite the `screenshot` method**

Replace the whole `screenshot` method (currently ~lines 192-212) with:

```ts
    screenshot: async () => {
      // Bun.WebView.screenshot() returns a Blob (image/png) for the full page.
      // Element-bounded screenshots are not supported in v1.
      const data = await (view as { screenshot?: () => Promise<Blob | string> }).screenshot?.();
      if (!data) throw new Error('screenshot: not supported by this Bun.WebView');
      const bytes = await pngBytesFrom(data);
      if (!isLikelyPng(bytes)) {
        throw new Error('screenshot: WebView returned an empty/invalid image');
      }
      return Buffer.from(bytes).toString('base64');
    },
```

- [ ] **Step 3: Update the daemon screenshot op**

In `src/daemon.ts`, replace the `case "screenshot":` block (~lines 105-111):

```ts
        case "screenshot": {
          const r = await browser.screenshot({
            selector: args[0] as string | undefined,
            path: args[1] as string | undefined,
          });
          return { id: req.id, ok: true, result: r };
        }
```

with:

```ts
        case "screenshot": {
          // Browser returns base64 PNG; the CLI writes the file (so a relative
          // --filename resolves against the user's cwd, not the daemon's).
          const r = await browser.screenshot();
          return { id: req.id, ok: true, result: r };
        }
```

- [ ] **Step 4: Build + full unit suite**

Run: `bun build src/cli.ts --compile --outfile /tmp/bowser-t2 && echo BUILD_OK`
Expected: BUILD_OK.

Run: `bun test`
Expected: the two existing `screenshot` describe tests in `tests/commands.test.ts` will now FAIL (they assume the old behavior) — that's expected; Task 3 updates them. All OTHER tests pass. (If you prefer a fully-green commit, do Task 3 before committing Task 2; otherwise note the known-failing screenshot tests.)

- [ ] **Step 5: Commit (with Task 3, or note the temporarily-failing screenshot tests)**

Recommended: implement Task 3 in the same working session and commit Tasks 2+3 together so the suite stays green. If committing separately:

```bash
git add src/browser.ts src/daemon.ts
git commit -m "feat: browser.screenshot() returns base64 PNG bytes (Blob-decoded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `cmdScreenshot` writes the file CLI-side (default name)

**Files:**
- Modify: `src/commands.ts` (`cmdScreenshot`)
- Test: `tests/commands.test.ts` (the `screenshot` describe block ~line 482; `fakeClient` screenshot handler ~line 32 + 80)

- [ ] **Step 1: Update the failing tests**

In `tests/commands.test.ts`, first update the `fakeClient` screenshot handler. Change its type (~line 32) from:

```ts
  screenshot?: (selector?: string, path?: string) => string | undefined;
```

to:

```ts
  screenshot?: (selector?: string) => string;
```

and its switch case (~line 80-81) from:

```ts
        case "screenshot":
          return handlers.screenshot?.(args[0] as string | undefined, args[1] as string | undefined);
```

to:

```ts
        case "screenshot":
          return handlers.screenshot?.(args[0] as string | undefined);
```

Then replace the entire `describe("screenshot", ...)` block (~lines 482-496) with:

```ts
describe("screenshot", () => {
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  test("--filename decodes the base64 and writes a real PNG at the given path", async () => {
    const tmpFile = join(tmp, `shot-${Date.now()}.png`);
    const c = fakeClient({ screenshot: () => PNG_B64 });
    const out = await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: tmpFile });
    expect(out).toBe(`wrote ${tmpFile}`);
    const written = new Uint8Array(await Bun.file(tmpFile).arrayBuffer());
    expect([...written.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("no --filename writes a default screenshot-<session>.png in the cwd", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp); // write the default file into the throwaway tmp dir
    try {
      const session = "shotdefault";
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      expect(out).toBe("wrote screenshot-shotdefault.png");
      expect(await Bun.file(join(tmp, "screenshot-shotdefault.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("no --filename auto-increments when the default file already exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const session = "shotinc";
      await Bun.write(join(tmp, "screenshot-shotinc.png"), "existing");      // occupy the base name
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      expect(out).toBe("wrote screenshot-shotinc-1.png");
      expect(await Bun.file(join(tmp, "screenshot-shotinc-1.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });
});
```

(`tmp` is the test file's tmp HOME dir created in `beforeAll`; `join` is already imported. The `ctx()`/inline-ctx pattern matches the existing tests.)

Also append pure unit tests for the increment helper to `tests/screenshot.test.ts` (created in Task 1):

```ts
import { nextAvailablePath } from "../src/commands.ts";

describe("nextAvailablePath", () => {
  test("returns the base name when it doesn't exist", async () => {
    const out = await nextAvailablePath("shot.png", async () => false);
    expect(out).toBe("shot.png");
  });

  test("increments past existing files until a free name", async () => {
    const taken = new Set(["shot.png", "shot-1.png", "shot-2.png"]);
    const out = await nextAvailablePath("shot.png", async (p) => taken.has(p));
    expect(out).toBe("shot-3.png");
  });

  test("inserts the suffix before the extension", async () => {
    const out = await nextAvailablePath("a/b/screenshot-x.png", async (p) => p === "a/b/screenshot-x.png");
    expect(out).toBe("a/b/screenshot-x-1.png");
  });

  test("handles a name with no extension", async () => {
    const out = await nextAvailablePath("shot", async (p) => p === "shot");
    expect(out).toBe("shot-1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands.test.ts -t "screenshot"`
Expected: FAIL — `cmdScreenshot` still expects the daemon to have written the file / returns base64.

- [ ] **Step 3: Add `nextAvailablePath` and rewrite `cmdScreenshot`**

In `src/commands.ts`, add the exported pure helper (near `cmdScreenshot`):

```ts
/** Find a non-colliding path: returns `base` if free, else base-1, base-2, …
 *  (suffix inserted before the extension). `exists` is injected for testing. */
export async function nextAvailablePath(
  base: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(base))) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!(await exists(cand))) return cand;
  }
}
```

Then replace the whole `cmdScreenshot` function with:

```ts
export async function cmdScreenshot(
  ctx: CommandContext,
  opts: { ref?: string; filename?: string } = {},
): Promise<string> {
  const selector = opts.ref ? (await loadRef(ctx.session, opts.ref)).target.selector : undefined;
  // Explicit --filename writes exactly there (overwrites). The default name
  // auto-increments so repeated screenshots don't clobber each other.
  const filename =
    opts.filename ??
    (await nextAvailablePath(`screenshot-${ctx.session}.png`, (p) => Bun.file(p).exists()));
  return withClient(ctx, async (c) => {
    const b64 = (await c.request("screenshot", [selector])) as string;
    await Bun.write(filename, Buffer.from(b64, "base64"));
    return ctx.json ? JSON.stringify({ ok: true, filename }) : `wrote ${filename}`;
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/commands.test.ts -t "screenshot"`
Expected: PASS (2 tests).

Run: `bun test`
Expected: 0 failures (Task 2 + Task 3 together make the suite green).

- [ ] **Step 5: Live verification (macOS, real browser)**

```bash
CACHE=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1)
nohup env BOWSER_CHROMIUM_PATH="$CACHE" bun run src/cli.ts open https://example.com --session shotlive >/dev/null 2>&1 & disown; sleep 6
BOWSER_CHROMIUM_PATH="$CACHE" bun run src/cli.ts screenshot --filename=/tmp/live.png --session shotlive
file /tmp/live.png   # expect: PNG image data
BOWSER_CHROMIUM_PATH="$CACHE" bun run src/cli.ts close --session shotlive >/dev/null 2>&1; pkill -f "daemon-main.*shotlive" 2>/dev/null
```
Expected: `wrote /tmp/live.png`, and `file` reports a real PNG (tens of KB), not a 7-byte stub.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts src/daemon.ts src/commands.ts tests/commands.test.ts
git commit -m "fix: screenshots write real PNGs; decode the Blob, write CLI-side (#2)

view.screenshot() returns a Blob; the old code stringified it to
'[object Blob]' and base64-decoded garbage (the dogfooding 7-byte PNG).
Decode the Blob to PNG bytes and write the file in the CLI process so a
relative --filename resolves against the user's cwd. No --filename writes
screenshot-<session>.png.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(If Task 2 was committed separately, stage only `src/commands.ts` and `tests/commands.test.ts` here.)

---

## Task 4: `shutdown` bypasses the serializer (PR P1)

**Files:**
- Modify: `src/daemon.ts` (the `Bun.listen` data handler dispatch)

No unit test (daemon integration); verified by build + reasoning + manual.

- [ ] **Step 1: Special-case shutdown in the dispatch**

In `src/daemon.ts`, the data handler currently wraps every request in `serialize(...)`. Wrap that existing block in a shutdown check. Replace the `serialize(() => { ... }).catch(() => {});` dispatch with:

```ts
          if (req.op === "shutdown") {
            // Shutdown must NOT queue behind a wedged op — its job is to kill a
            // possibly-stuck daemon. Dispatch it directly, bypassing the serializer.
            handle(req).then((res) => {
              socket.write(JSON.stringify(res) + "\n");
            });
          } else {
            serialize(() => {
              const underlying = handle(req);
              withTimeout(underlying, timeoutMs, req.op).then(
                (res) => {
                  socket.write(JSON.stringify(res) + "\n");
                },
                (err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  socket.write(JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
                },
              );
              return underlying;
            }).catch(() => {
              // handle() never rejects; guards against an unhandled rejection.
            });
          }
```

(Keep the surrounding comment about why serialization holds the lock; this just adds the shutdown fast-path.)

- [ ] **Step 2: Build + full suite**

Run: `bun build src/cli.ts --compile --outfile /tmp/bowser-t4 && echo BUILD_OK`
Expected: BUILD_OK.

Run: `bun test`
Expected: 0 failures.

- [ ] **Step 3: Manual recovery check (macOS)**

Verify `close` returns promptly even while an op is running:

```bash
CACHE=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1)
nohup env BOWSER_CHROMIUM_PATH="$CACHE" bun run src/cli.ts open https://example.com --session busy >/dev/null 2>&1 & disown; sleep 6
# kick off a slow evaluate in the background, then immediately close:
BOWSER_CHROMIUM_PATH="$CACHE" bun run src/cli.ts close --session busy
pkill -f "daemon-main.*busy" 2>/dev/null
```
Expected: `closed session 'busy'` returns within ~1s (shutdown not blocked). If you can't reliably stage a wedged op in this environment, rely on the code review of the bypass logic and note it.

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "fix: shutdown bypasses the op serializer so close always works (PR #8 P1)

A wedged op held the serializer queue, so close/close --all against a stuck
daemon hung forever. Dispatch shutdown directly, outside the serializer —
killing the (possibly stuck) WebView is the recovery path.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `socketPath` delegates to `sessionsRoot()` (PR P2)

**Files:**
- Modify: `src/daemon.ts` (`socketPath` ~line 48; imports)
- Test: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/daemon.test.ts`, add (import `socketPath` from `../src/daemon.ts` and `join`/`tmpdir` as needed — check existing imports first):

```ts
import { socketPath } from "../src/daemon.ts";

describe("socketPath", () => {
  test("resolves under process.env.HOME at call time", () => {
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/bowser-sockpath-test";
    try {
      expect(socketPath("sess")).toBe("/tmp/bowser-sockpath-test/.bowser/sessions/sess/sock");
    } finally {
      if (orig !== undefined) process.env.HOME = orig; else delete process.env.HOME;
    }
  });
});
```

- [ ] **Step 2: Run to verify it passes or fails**

Run: `bun test tests/daemon.test.ts -t "socketPath"`
Expected: PASS already (the current inlined `process.env.HOME || homedir()` produces the same path). This test pins the behavior so the refactor in Step 3 is safe. If it fails, the path shape differs — investigate before refactoring.

- [ ] **Step 3: Refactor to use `sessionsRoot()`**

In `src/daemon.ts`, add `sessionsRoot` to the `./state.ts` import (find the existing `import { ... } from "./state.ts";` line; if there is none, add `import { sessionsRoot } from "./state.ts";`). Then replace `socketPath`:

```ts
export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(sessionsRoot(), session, "sock");
}
```

If `homedir` is now unused in `src/daemon.ts`, remove it from the `node:os` import.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/daemon.test.ts -t "socketPath"`
Expected: PASS (path unchanged).

Run: `bun test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "refactor: socketPath reuses sessionsRoot() (PR #8 P2)

Single source of truth for the sessions root, shared with state.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Correct the #2 record (docs + issue + PR)

**Files:**
- Modify: `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md`, `AGENTS.md`
- Update: GitHub issue #7 comment + PR #8 body (via `gh`)

- [ ] **Step 1: README.md**

Find the screenshot "Known limitations" note added earlier (it says screenshots are unsupported / return an empty image on both backends). Replace it with an accurate statement:

```markdown
Screenshots are written as PNG files. `bowser screenshot --filename out.png` writes
to `out.png` (relative paths resolve against your current directory); without
`--filename` it writes `screenshot-<session>.png`. Element-bounded (selector)
screenshots are not supported yet — captures are full-page.
```

Remove any "use BOWSER_BACKEND=chrome" / "upstream Bun limitation" wording for screenshots.

- [ ] **Step 2: skills/bowser/SKILL.md**

Replace the screenshot known-limitation one-liner with: screenshots work and are written as PNG files (`--filename`, or default `screenshot-<session>.png`); full-page only.

- [ ] **Step 3: CHANGELOG.md**

In the `[Unreleased]` section, move the screenshot item out of "Known limitations" into "Fixed": `screenshot now writes a valid PNG (decode the Blob returned by Bun.WebView.screenshot(); the CLI writes the file so a relative --filename resolves against the user's cwd) (#2)`. Remove the old "known limitation" screenshot line.

- [ ] **Step 4: AGENTS.md**

Replace the gotcha bullet that says `Bun.WebView.screenshot()` is broken on both backends with:

```markdown
- **`Bun.WebView.screenshot()` returns a `Blob`, not a base64 string.** Decode it
  via `pngBytesFrom()` (`src/browser.ts`) — `String(blob)` is `"[object Blob]"`,
  which silently produced the old 7-byte "PNG". `cmdScreenshot` writes the file in
  the CLI process; `browser.screenshot()` only returns base64.
```

- [ ] **Step 5: Commit**

```bash
git add README.md skills/bowser/SKILL.md CHANGELOG.md AGENTS.md
git commit -m "docs: screenshot is fixed (Blob decode), not an upstream limitation (#2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Correct issue #7 + PR #8**

Post a correction comment on issue #7:

```bash
gh issue comment 7 --body "**Correction on #2 (screenshot):** further investigation showed this is *not* an upstream Bun limitation — \`Bun.WebView.screenshot()\` returns a valid PNG \`Blob\` (~67KB). bowser was stringifying the Blob (\`String(blob)\` → \`\"[object Blob]\"\`) and base64-decoding garbage, producing the 7-byte file. **Fixed in bowser** by decoding the Blob to PNG bytes and writing the file CLI-side. Screenshots now work on both backends; no upstream issue needed."
```

Post a correction comment on PR #8:

```bash
gh pr comment 8 --body "Update: #2 (screenshot) is now **fixed**, not an upstream limitation. \`view.screenshot()\` returns a valid PNG \`Blob\`; the old code stringified it. The branch now decodes the Blob and writes the file CLI-side (default \`screenshot-<session>.png\`). Also addressed review: \`shutdown\` bypasses the op serializer (P1) so \`close\` always works against a stuck daemon, and \`socketPath\` now reuses \`sessionsRoot()\` (P2)."
```

---

## Done-When

- `bun test` green, including `tests/screenshot.test.ts` and the rewritten `cmdScreenshot` tests.
- `bowser screenshot --filename=x.png` writes a real PNG (`file` reports PNG); no `--filename` writes `screenshot-<session>.png`, auto-incrementing (`-1`, `-2`, …) if it already exists; relative paths resolve against the user's cwd.
- `close` returns promptly even with an op in flight (shutdown bypass).
- `socketPath` reuses `sessionsRoot()`; path unchanged.
- Docs, issue #7, and PR #8 describe #2 as fixed (Blob handling), not upstream.
