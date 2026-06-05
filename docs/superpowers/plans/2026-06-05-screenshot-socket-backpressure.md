# Screenshot Socket Backpressure Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `bowser screenshot` from hanging by honoring Bun's partial-write socket contract in the daemon, and keep the large PNG payload off the socket entirely by writing the file daemon-side.

**Architecture:** A new `src/socket-write.ts` primitive buffers any unsent bytes per-socket and flushes them on `drain`; the daemon and client route every write through it. Separately, the `screenshot` op gains an absolute-path argument so the daemon writes the PNG itself and returns only a tiny `{ path }`.

**Tech Stack:** Bun (`Bun.listen`/`Bun.connect` low-level sockets, `Bun.write`, `Bun.file`), TypeScript, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-05-screenshot-socket-backpressure-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/socket-write.ts` | **new** — `socketWriteAll` / `flushSocket`: per-socket backpressure-aware writing |
| `tests/socket-write.test.ts` | **new** — unit test reproducing the partial-write truncation |
| `src/daemon.ts` | route all socket writes through `socketWriteAll`; add `drain` handlers; `screenshot` op writes file when given a path |
| `src/commands.ts` | `cmdScreenshot` resolves an absolute path and sends it |
| `tests/commands.test.ts` | `fakeClient` simulates daemon-side file write; assert absolute path is sent |
| `tests/e2e.test.ts` | real screenshot → valid PNG; large snapshot round-trips without truncation |

---

## Task 1: Backpressure-aware socket writer

**Files:**
- Create: `src/socket-write.ts`
- Test: `tests/socket-write.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/socket-write.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { socketWriteAll, flushSocket, type WritableSocket } from "../src/socket-write.ts";

// Fake socket that accepts at most `cap` bytes per write() call (modeling a
// small kernel send buffer) and records everything it accepts.
function fakeSocket(cap: number) {
  const out: number[] = [];
  const sock: WritableSocket & { out: number[] } = {
    out,
    write(data: Uint8Array): number {
      const n = Math.min(cap, data.length);
      for (let i = 0; i < n; i++) out.push(data[i]);
      return n;
    },
  };
  return sock;
}

describe("socketWriteAll backpressure", () => {
  test("delivers a payload larger than the per-write cap, across drains", () => {
    const sock = fakeSocket(8); // 8 bytes per write, like a small send buffer
    const payload = "x".repeat(100) + "\n";
    socketWriteAll(sock, payload);
    // The first flush accepts only one cap's worth; the rest stays buffered.
    expect(sock.out.length).toBe(8);
    // Simulate repeated drain events until the buffer empties.
    let guard = 0;
    while (sock.out.length < payload.length && guard++ < 1000) flushSocket(sock);
    expect(Buffer.from(sock.out).toString("utf-8")).toBe(payload);
  });

  test("operates on bytes, never splitting a multibyte UTF-8 codepoint", () => {
    const sock = fakeSocket(3);
    const payload = "héllo—wörld"; // 2-byte é/ö, 3-byte em dash
    socketWriteAll(sock, payload);
    let guard = 0;
    while (Buffer.from(sock.out).toString("utf-8").length < payload.length && guard++ < 1000) {
      flushSocket(sock);
    }
    expect(Buffer.from(sock.out).toString("utf-8")).toBe(payload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/socket-write.test.ts`
Expected: FAIL — `Cannot find module '../src/socket-write.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/socket-write.ts`:

```ts
// Backpressure-aware writing for the daemon's Unix sockets.
//
// Bun's low-level socket.write() may perform a PARTIAL write when the kernel
// send buffer is full, returning the number of bytes actually accepted. The
// caller must buffer the remainder and flush it when the socket fires `drain`.
// Skipping this silently truncates any payload larger than the send buffer
// (~8 KB on macOS Unix sockets) — which is what made `bowser screenshot`
// (a ~140 KB base64 PNG) hang: the reader never saw the closing newline.

export interface WritableSocket {
  // Bun sockets accept string | ArrayBufferView and return bytes written.
  write(data: Uint8Array): number;
}

interface WriteQueue {
  chunks: Uint8Array[];
  offset: number; // bytes of chunks[0] already written
}

function queueFor(socket: WritableSocket): WriteQueue {
  const s = socket as WritableSocket & { _wq?: WriteQueue };
  if (!s._wq) s._wq = { chunks: [], offset: 0 };
  return s._wq;
}

/** Encode `str` as UTF-8, enqueue it, and flush as far as the socket allows. */
export function socketWriteAll(socket: WritableSocket, str: string): void {
  const q = queueFor(socket);
  q.chunks.push(new Uint8Array(Buffer.from(str, "utf-8")));
  flushSocket(socket);
}

/** Flush buffered bytes until the socket stalls. Safe to call from `drain`. */
export function flushSocket(socket: WritableSocket): void {
  const q = queueFor(socket);
  while (q.chunks.length > 0) {
    const head = q.chunks[0];
    const n = socket.write(head.subarray(q.offset));
    if (n > 0) q.offset += n;
    if (q.offset >= head.length) {
      q.chunks.shift();
      q.offset = 0;
    } else {
      // Partial or zero write — wait for `drain` before retrying.
      break;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/socket-write.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/socket-write.ts tests/socket-write.test.ts
git commit -m "feat: backpressure-aware socket writer (issue #9)"
```

---

## Task 2: Route daemon + client writes through socketWriteAll

**Files:**
- Modify: `src/daemon.ts` (imports; 4 server write sites; client write site; 2 `drain` handlers)

This task has no new unit test — its correctness is proven end-to-end by the e2e tests in Task 4. The existing suite must stay green.

- [ ] **Step 1: Add the import**

In `src/daemon.ts`, below the existing `import { createSerializer, withTimeout } from "./serialize.ts";` line, add:

```ts
import { socketWriteAll, flushSocket } from "./socket-write.ts";
```

- [ ] **Step 2: Replace the four server-side writes**

In the `Bun.listen` `data(socket, data)` handler, replace each `socket.write(... + "\n")` with `socketWriteAll`:

The invalid-JSON reply:
```ts
          } catch (err) {
            socketWriteAll(
              socket,
              JSON.stringify({
                id: -1,
                ok: false,
                error: "invalid JSON: " + String(err),
              }) + "\n",
            );
            continue;
          }
```

The shutdown reply:
```ts
            handle(req).then((res) => {
              socketWriteAll(socket, JSON.stringify(res) + "\n");
            }).catch(() => {
              // handle() never rejects; mirrors the guard on the serialized path.
            });
```

The serialized success + timeout replies:
```ts
              withTimeout(underlying, timeoutMs, req.op).then(
                (res) => {
                  socketWriteAll(socket, JSON.stringify(res) + "\n");
                },
                (err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  socketWriteAll(socket, JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
                },
              );
```

- [ ] **Step 3: Add a `drain` handler to the server socket**

In the same `Bun.listen({ unix: sock, socket: { ... } })` object, alongside `open` and `error`, add:

```ts
      drain(socket) {
        flushSocket(socket as unknown as import("./socket-write.ts").WritableSocket);
      },
```

- [ ] **Step 4: Route the client request write + add its `drain` handler**

In `DaemonClient.connect`, the `Bun.connect({ unix, socket: { data(...) {...} } })` object — add a `drain` handler next to `data`:

```ts
        drain(s) {
          flushSocket(s as unknown as import("./socket-write.ts").WritableSocket);
        },
```

In `DaemonClient.request`, replace:
```ts
      this.sock!.write(line);
```
with:
```ts
      socketWriteAll(
        this.sock! as unknown as import("./socket-write.ts").WritableSocket,
        line,
      );
```

- [ ] **Step 5: Verify the full suite still passes**

Run: `bun test`
Expected: PASS — same test count as before this task (no regressions; e2e still skipped without `BOWSER_E2E=1`).

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts
git commit -m "fix: honor socket backpressure in daemon + client (issue #9)"
```

---

## Task 3: Daemon writes the PNG; CLI sends an absolute path

**Files:**
- Modify: `src/daemon.ts` (`screenshot` op)
- Modify: `src/commands.ts` (`cmdScreenshot`; add `resolve` import)
- Modify: `tests/commands.test.ts` (`fakeClient` screenshot case; new absolute-path test)

- [ ] **Step 1: Write the failing test**

In `tests/commands.test.ts`, add the `isAbsolute` import. Change:
```ts
import { join } from "node:path";
```
to:
```ts
import { isAbsolute, join } from "node:path";
```

Then add this test inside the `describe("screenshot", () => { ... })` block (after the existing auto-increment test):

```ts
  test("sends an ABSOLUTE path so the daemon (different cwd) writes to the right place", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c = fakeClient({ screenshot: () => PNG_B64 });
      await cmdScreenshot(
        { session: "shotabs", json: false, connect: async () => c },
        { filename: "rel.png" },
      );
      const call = c.calls.find(([op]) => op === "screenshot")!;
      expect(isAbsolute(call[1][0] as string)).toBe(true);
      expect(call[1][0]).toBe(join(tmp, "rel.png"));
    } finally {
      process.chdir(origCwd);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands.test.ts -t "ABSOLUTE path"`
Expected: FAIL — the current `cmdScreenshot` sends `[]` (no args), so `c.calls.find(...)` returns a call with `args === []` and `call[1][0]` is `undefined`, failing `isAbsolute`.

- [ ] **Step 3: Update `fakeClient` to simulate the daemon writing the file**

In `tests/commands.test.ts`, the `screenshot` case currently is:
```ts
        case "screenshot":
          return handlers.screenshot?.(args[0] as string | undefined);
```
Replace it with:
```ts
        case "screenshot": {
          // Mirror the real daemon: when given a path, write the PNG and return
          // just { path }; otherwise return base64.
          const path = args[0] as string | undefined;
          const b64 = handlers.screenshot?.(path) ?? "";
          if (path) {
            await Bun.write(path, Buffer.from(b64, "base64"));
            return { path };
          }
          return b64;
        }
```

- [ ] **Step 4: Update `cmdScreenshot` to resolve + send an absolute path**

In `src/commands.ts`, change the path import:
```ts
import { join } from "node:path";
```
to:
```ts
import { join, resolve } from "node:path";
```

Replace the body of `cmdScreenshot` (currently lines ~225–239) with:
```ts
export async function cmdScreenshot(
  ctx: CommandContext,
  opts: { filename?: string } = {},
): Promise<string> {
  // Full-page only. The default name auto-increments so repeated screenshots
  // don't clobber each other; an explicit --filename writes exactly there.
  const filename =
    opts.filename ??
    (await nextAvailablePath(`screenshot-${ctx.session}.png`, (p) => Bun.file(p).exists()));
  // Resolve against the CLI's cwd and let the daemon write the file. The daemon
  // runs with a different cwd, and its PNG payload (~140 KB base64) must not be
  // shipped back over the socket — so we hand it an absolute target path.
  const abs = resolve(process.cwd(), filename);
  return withClient(ctx, async (c) => {
    await c.request("screenshot", [abs]);
    return ctx.json ? JSON.stringify({ ok: true, filename }) : `wrote ${filename}`;
  });
}
```

- [ ] **Step 5: Update the daemon `screenshot` op**

In `src/daemon.ts`, replace the `case "screenshot":` block (currently lines ~105–110) with:
```ts
        case "screenshot": {
          // When the CLI passes an absolute path, the daemon writes the PNG
          // itself so the ~140 KB base64 never crosses the socket. With no path,
          // return base64 (now safe to transmit thanks to socketWriteAll).
          const path = args[0] as string | undefined;
          const b64 = await browser.screenshot();
          if (path) {
            await Bun.write(path, Buffer.from(b64, "base64"));
            return { id: req.id, ok: true, result: { path } };
          }
          return { id: req.id, ok: true, result: b64 };
        }
```

- [ ] **Step 6: Run the screenshot tests to verify they pass**

Run: `bun test tests/commands.test.ts -t "screenshot"`
Expected: PASS — all four screenshot tests (the three existing ones now pass because `fakeClient` writes the file; the new one passes because an absolute path is sent).

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS — no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/daemon.ts src/commands.ts tests/commands.test.ts
git commit -m "feat: write screenshot file daemon-side, keep PNG off the socket (issue #9)"
```

---

## Task 4: End-to-end coverage against a real browser

**Files:**
- Modify: `tests/e2e.test.ts` (imports; two new tests)

These are gated on `BOWSER_E2E=1`. The screenshot test proves Part B end-to-end; the large-snapshot test proves Part A — a >8 KB response now survives the real socket instead of truncating.

- [ ] **Step 1: Add imports**

In `tests/e2e.test.ts`, change:
```ts
import { detectChromium } from "../src/browser.ts";
import { cmdClick, cmdClose, cmdOpen, cmdSnapshot } from "../src/commands.ts";
```
to:
```ts
import { detectChromium, isLikelyPng } from "../src/browser.ts";
import { cmdClick, cmdClose, cmdOpen, cmdScreenshot, cmdSnapshot } from "../src/commands.ts";
```

- [ ] **Step 2: Write the screenshot e2e test**

Inside the `runOrSkip("e2e: real Chromium", () => { ... })` block, add (use the same `session` and `tmp` already in scope):

```ts
  test("screenshot writes a valid, non-truncated PNG file", async () => {
    await cmdOpen({ session, json: false }, { url: `data:text/html,${encodeURIComponent(html)}` });
    const file = join(tmp, "e2e-shot.png");
    const out = await cmdScreenshot({ session, json: false }, { filename: file });
    expect(out).toBe(`wrote ${file}`);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    expect(isLikelyPng(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000); // a real capture, not a stub
  });
```

- [ ] **Step 3: Write the large-response e2e test (Part A regression)**

Add, in the same block:

```ts
  test("a >8 KB snapshot response survives the socket (backpressure)", async () => {
    // 2000 list items produce well over 8 KB of aria YAML — larger than the
    // kernel send buffer that previously truncated screenshot responses.
    const items = Array.from({ length: 2000 }, (_, i) => `<li>item-${i}</li>`).join("");
    const big = `<html><head><title>Big</title></head><body><ul>${items}</ul></body></html>`;
    await cmdOpen({ session, json: false }, { url: `data:text/html,${encodeURIComponent(big)}` });
    const yaml = await cmdSnapshot({ session, json: false }, {});
    expect(yaml.length).toBeGreaterThan(8192);
    expect(yaml).toContain("item-0");
    expect(yaml).toContain("item-1999"); // the tail proves nothing was truncated
  });
```

- [ ] **Step 4: Run the e2e suite**

Run (macOS, using a cached/system Chromium):
```bash
BOWSER_E2E=1 \
  BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
  bun test tests/e2e.test.ts
```
Expected: PASS — including the two new tests. If no Chromium is cached, run `./dist/bowser install --force` (or `bun run src/cli.ts install --force`) first.

- [ ] **Step 5: Confirm the original repro is fixed**

```bash
bun build src/cli.ts --compile --outfile dist/bowser
./dist/bowser open https://example.com --session shot
./dist/bowser screenshot --session shot --filename /tmp/bowser-shot.png
./dist/bowser close --session shot
file /tmp/bowser-shot.png   # => PNG image data, ...
```
Expected: `screenshot` returns `wrote /tmp/bowser-shot.png` promptly (no 30 s hang) and `file` reports a valid PNG. This runs on the default macOS WebKit backend — the exact issue #9 scenario.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test: e2e screenshot + large-response backpressure coverage (issue #9)"
```

---

## Task 5: Docs + changelog

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md` (gotchas) — optional but recommended

- [ ] **Step 1: Add a changelog entry**

In `CHANGELOG.md`, add a section under the top (matching the existing `## [x.y.z] — YYYY-MM-DD` format):

```markdown
## [Unreleased]

### Fixed

- `screenshot` no longer hangs. The daemon ignored Bun's partial-write socket
  contract, so any response larger than the ~8 KB send buffer (a ~140 KB base64
  PNG) was truncated and the client hung until timeout. Writes now buffer and
  flush on `drain`. Screenshots are additionally written daemon-side, keeping the
  PNG payload off the socket entirely. (#9)
```

- [ ] **Step 2: Add a gotcha to CLAUDE.md**

In `CLAUDE.md`, under "## Gotchas (lessons learned)", add:

```markdown
- **`socket.write()` does partial writes.** Bun's low-level socket `write()`
  returns the bytes actually accepted and silently drops the rest under
  backpressure (~8 KB send buffer on macOS). Always route daemon/client writes
  through `socketWriteAll()` (`src/socket-write.ts`) and keep the `drain`
  handlers wired in `Bun.listen`/`Bun.connect`. A raw `socket.write(bigString)`
  truncates any payload over the buffer size — this is what made `screenshot`
  (a ~140 KB base64 PNG) hang.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: note socket backpressure fix + gotcha (issue #9)"
```

---

## Self-Review notes

- **Spec coverage:** Part A → Tasks 1+2 (primitive) and Task 4 large-snapshot test (wiring). Part B → Task 3 and Task 4 screenshot test. Tests section of the spec → Tasks 1, 3, 4. All covered.
- **Type consistency:** `socketWriteAll(socket, str)` / `flushSocket(socket)` / `WritableSocket` used identically across `socket-write.ts`, `daemon.ts`, and the test. The `screenshot` op returns `{ path }` when given a path; `cmdScreenshot` ignores the returned shape and reports `wrote ${filename}`, so the user-facing message is unchanged from today.
- **Request-direction note:** the client `request` write is also routed through `socketWriteAll` (Task 2, Step 4), so a >8 KB request (e.g. a large `fill`) is covered by the same primitive proven in Task 1; no separate e2e is added for it to keep the browser-dependent surface small.
```
