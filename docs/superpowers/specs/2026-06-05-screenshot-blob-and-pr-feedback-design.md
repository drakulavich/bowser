# Screenshot real fix + PR #8 feedback

**Status:** approved (design)
**Date:** 2026-06-05
**Branch:** `fix/dogfooding-bugs-7` (extends PR #8)

## Background

Investigation while preparing to file an upstream Bun issue revealed that
`Bun.WebView.screenshot()` is **not** broken: it returns a `Blob`
(`type: image/png`, ~67 KB, valid PNG signature) on both backends. bowser's
screenshot code did `Buffer.from(String(data), 'base64')`, and `String(aBlob)`
is the literal `"[object Blob]"` (13 chars) → base64-garbage → the ~7–9 byte
"broken PNG" seen in dogfooding (#2). So #2 is a bowser bug, fully fixable — not
an upstream limitation, and no upstream issue should be filed.

Separately, Greptile review of PR #8 raised two findings (P1, P2) addressed here.

## Part 1 — Screenshot, actually fixed (#2)

Decode the `Blob` and move the file write from the daemon to the CLI (so a
relative `--filename` resolves against the user's cwd, not the long-lived
daemon's spawn-time cwd — a latent bug).

**`src/browser.ts`:**
- Add a pure, exported helper:
  ```ts
  export async function pngBytesFrom(data: Blob | string): Promise<Uint8Array> {
    if (typeof data === "string") return new Uint8Array(Buffer.from(data, "base64"));
    return new Uint8Array(await data.arrayBuffer());
  }
  ```
  (Handles the current `Blob` return and a defensive `string`/base64 fallback.)
- `screenshot` no longer takes/uses a `path`; it returns base64 of the real PNG
  bytes always:
  ```ts
  screenshot: async () => {
    const data = await (view as { screenshot?: () => Promise<Blob | string> }).screenshot?.();
    if (!data) throw new Error('screenshot: not supported by this Bun.WebView');
    const bytes = await pngBytesFrom(data);
    if (!isLikelyPng(bytes)) throw new Error('screenshot: WebView returned an empty/invalid image');
    return Buffer.from(bytes).toString("base64");
  }
  ```
- The `Browser.screenshot` interface becomes `screenshot(): Promise<string>` (base64).
  Drop the `{ selector?; path? }` options object — selector was always ignored
  (full-page only, a documented v1 limitation) and path moves to the CLI.
- Update the stale comment/error wording (remove the "unsupported upstream" text).
- Keep `isLikelyPng` as a sanity guard; real screenshots (~67 KB) pass it, a
  genuinely empty capture still fails loud.

**`src/daemon.ts`:** the `screenshot` op calls `browser.screenshot()` (no args)
and returns the base64 string as `result`.

**`src/commands.ts` `cmdScreenshot`:**
- Still resolves `opts.ref` → selector for forward-compat, but selector is unused
  by the browser (full-page); keep current behavior (no error).
- Receives base64 from the daemon. When `opts.filename`: `await Bun.write(filename,
  Buffer.from(base64, "base64"))` **in the CLI process**, then report `wrote <filename>`.
  When no filename: return the base64 string (existing behavior — print to stdout).

**Tests:**
- `tests/screenshot.test.ts` (new): `pngBytesFrom` with a `Blob` (construct
  `new Blob([bytes], { type: "image/png" })`) and with a base64 string → both
  yield the original bytes.
- `tests/commands.test.ts`: `cmdScreenshot` with `--filename` and a `fakeClient`
  returning valid-PNG base64 writes a real PNG file (assert the file exists and
  starts with the PNG signature); without `--filename` returns the base64.
- `isLikelyPng` tests stay as-is.

## Part 2 — PR P1: `shutdown` bypasses the serializer

Greptile (daemon.ts:189): now that ops serialize, `shutdown` queues behind a
wedged `underlying`, so `close`/`close --all` against a stuck daemon hangs
forever — a regression from concurrent dispatch where `close` was always
effective. Fix: in the `Bun.listen` data handler, route `req.op === "shutdown"`
**directly** to `handle(req)` (no `serialize`, no `withTimeout`), so it always
runs immediately:

```ts
if (req.op === "shutdown") {
  handle(req).then((res) => socket.write(JSON.stringify(res) + "\n"));
} else {
  serialize(() => { /* existing underlying + withTimeout dispatch */ });
}
```

`shutdown`'s handler responds, then `queueMicrotask` closes the browser and
`process.exit(0)` — killing the (possibly wedged) WebView is exactly the recovery
path, so it must not wait behind the wedge.

## Part 3 — PR P2: `socketPath` delegates to `sessionsRoot()`

Greptile (daemon.ts:51): `socketPath` inlines `process.env.HOME || homedir()`
instead of reusing `sessionsRoot()`. Replace with:

```ts
import { sessionsRoot } from "./state.ts"; // add to imports
export function socketPath(session: string): string {
  return join(sessionsRoot(), session, "sock");
}
```

Single source of truth; `socketPath` and `sessionDir` now share it. Drop the
now-unused `homedir` import from daemon.ts if nothing else uses it.

## Part 4 — Correct the #2 record

- `README.md`, `skills/bowser/SKILL.md`, `CHANGELOG.md`, `AGENTS.md`: change the
  screenshot "known limitation / upstream" wording to "fixed — screenshots are
  written correctly (the Blob return is decoded to PNG bytes)". Remove the
  `BOWSER_BACKEND=chrome` / upstream-issue advice.
- Issue #7 comment + PR #8 body: post a correction noting #2 is fixed in bowser
  (Blob handling), not an upstream Bun bug.

## Out of scope

- Element-bounded (selector) screenshots — still full-page only.
- Changing the no-`--filename` behavior (still prints base64 to stdout).
- A client-side `DaemonClient.request` timeout (the shutdown bypass resolves the
  reported regression without it).

## Testing summary

- `bun test` green, including new `pngBytesFrom` + `cmdScreenshot`-writes-file tests.
- Live verify: `bowser screenshot --filename=/tmp/x.png` writes a valid ~67 KB PNG
  (`file` reports PNG); a relative `--filename` lands in the user's cwd; `close`
  against a busy daemon returns promptly.
