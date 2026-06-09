# Screenshot hang — daemon socket backpressure fix

**Issue:** [#9 — Screenshot command hangs indefinitely on WebKit backend](https://github.com/drakulavich/bowser/issues/9)
**Date:** 2026-06-05

## Problem

`bowser screenshot` hangs and is eventually killed by an external timeout. The
issue report blamed `Bun.WebView.screenshot()`, but that is a red herring.

### Root cause (proven)

The native screenshot API works fine. Probed directly on the WebKit backend
against both a `data:` URL and `https://example.com`, `view.screenshot()`
returns a valid PNG `Blob` (39 KB / 103 KB) in 20–43 ms.

The hang is in the **daemon's Unix-socket transport**. `src/daemon.ts` writes
responses with `socket.write(JSON.stringify(res) + "\n")` and **ignores the
return value**. Bun's `socket.write()` is low-level: under backpressure it
performs a *partial* write and returns the byte count actually sent, expecting
the caller to buffer the remainder and flush it on the `drain` event. The daemon
never does.

macOS Unix-socket send buffers are ~8 KB. Reproduced with a Bun socket pair: a
200 001-byte payload written in one `socket.write()` call returns `8192` and
silently drops the other ~192 KB. The reader's line buffer never sees the
closing `\n`, the pending request promise never resolves, and the caller hangs.

A screenshot is ~140 KB of base64 — the first command whose payload reliably
exceeds 8 KB. Every other core command (`click`, `fill`, `snapshot` of a small
page — request 3 981 bytes) fits in a single buffer and works. The per-op 30 s
timeout (`withTimeout`) does not catch it because the screenshot *op* succeeds in
~43 ms; only the *transmission* of its result is broken.

This is **backend-agnostic** — which is why the issue also saw Chromium time
out. It is not "screenshot missing on Chromium"; it is the same 140 KB payload
truncated regardless of backend.

### Generality

The bug affects any daemon response *or* request larger than the send buffer, in
both directions: a snapshot of a large page, a `localstorage-set`/`fill` with a
>8 KB value. Screenshot is simply the first reliable trigger.

## Design

Two parts. Part A is the root-cause fix; Part B is an efficiency layer on top.

### Part A — `socketWriteAll` (root-cause fix)

New module `src/socket-write.ts`:

```ts
// Honors Bun socket.write()'s partial-write contract: buffer the unsent
// remainder per-socket and flush it on `drain`. Operates on bytes, not chars,
// so multibyte UTF-8 (e.g. page titles in JSON) never splits mid-codepoint.
export function socketWriteAll(socket: BunSocket, str: string): void
export function flushSocket(socket: BunSocket): void
```

- Per-socket write state is attached to the socket object
  (`(socket as any)._wq = { chunks: Uint8Array[], offset: number }`), mirroring
  the existing `(socket as { data?: string }).data` convention.
- `socketWriteAll` encodes `str` to UTF-8 bytes (`Buffer.from(str)`), pushes the
  chunk onto the queue, and calls `flushSocket`.
- `flushSocket` loops: `const n = socket.write(head, offset)`; advance `offset`
  by `n`; when `offset` reaches the chunk length, shift to the next chunk and
  reset `offset`; if the write stalls short (including `n === 0`), break and wait
  for `drain`.
- Wire a `drain(socket) { flushSocket(socket) }` handler into **both**
  `Bun.listen` (daemon) and `Bun.connect` (client).
- Replace every raw write:
  - `src/daemon.ts` — the 4 response-write sites (invalid-JSON reply, shutdown
    reply, serialized success/timeout replies).
  - `src/daemon.ts` `DaemonClient.request` — the request write (`this.sock.write`).

This alone fixes screenshots, large snapshots, and big localStorage/fill values,
in both directions, permanently.

### Part B — daemon writes the PNG, returns the path

- `cmdScreenshot` resolves `filename` to an **absolute** path against
  `process.cwd()` (the daemon's cwd differs), and sends it:
  `c.request("screenshot", [absPath])`. The auto-increment default name is still
  computed CLI-side (it needs the user's cwd) then resolved to absolute.
- The daemon `screenshot` op accepts an optional path arg. When present:
  `const b64 = await browser.screenshot()` (stays in-process — never crosses the
  socket), then `await Bun.write(absPath, Buffer.from(b64, "base64"))`, and
  returns `{ ok: true, result: { path: absPath } }`. When absent, it returns the
  base64 as before (now safe to transmit thanks to Part A).
- `browser.screenshot()` is unchanged — still returns validated base64; the
  `isLikelyPng` guard stays.

With Part A in place, Part B is an efficiency win, not a correctness
requirement: it keeps a ~140 KB screenshot payload off the socket entirely.

## Tests (TDD)

1. **`tests/socket-write.test.ts`** — fake socket whose `write` caps at N bytes
   and records output; assert a >N-byte payload is delivered in full only after
   simulated `drain` calls, and that a multibyte UTF-8 payload is not split. This
   is the test that reproduces the bug (write returns < length → remainder must
   survive).
2. **`tests/commands.test.ts`** — `cmdScreenshot` sends an **absolute** path arg
   to the daemon and returns the `wrote <path>` / `{ ok, filename }` shape from
   the daemon's `{ path }` result. Extend `fakeClient` for the new `screenshot`
   arg/return shape.
3. **`tests/e2e.test.ts`** (gated on `BOWSER_E2E=1`) — real capture of a page;
   assert the file exists and `isLikelyPng(bytes)` with a realistic size floor.
   A true end-to-end screenshot test was missing — that gap is why this shipped.

## Out of scope

- `SO_SNDBUF` tuning or protocol re-framing (band-aids that only move the
  threshold).
- Element-bounded / clipped screenshots.
- Base64-to-stdout mode (current CLI always writes to a file).

## Files touched

| File | Change |
| --- | --- |
| `src/socket-write.ts` | **new** — `socketWriteAll` + `flushSocket` |
| `src/daemon.ts` | use `socketWriteAll` for all writes; add `drain` handlers; `screenshot` op writes file when given a path |
| `src/commands.ts` | `cmdScreenshot` resolves absolute path, sends it, returns daemon's path |
| `tests/socket-write.test.ts` | **new** — backpressure unit test |
| `tests/commands.test.ts` | screenshot arg/return assertions |
| `tests/e2e.test.ts` | real screenshot capture assertion |
