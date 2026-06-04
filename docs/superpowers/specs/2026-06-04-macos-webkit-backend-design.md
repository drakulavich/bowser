# Native WebKit backend on macOS by default

**Status:** approved (design)
**Date:** 2026-06-04

## Problem

`bowser` always drives a Chrome/Chromium backend through `Bun.WebView`, even on
macOS where Bun otherwise defaults to the system `WKWebView`. The chrome backend
requires either a system Chrome or a `bowser install` download. On macOS we can
use the native WebKit engine with nothing to install.

Today the backend is hardcoded in `src/browser.ts` (`openBrowser`, lines ~42–50):
the no-options branch resolves to `"chrome" as const`, and `daemon.ts` calls
`openBrowser()` with no options (the only caller). There is no seam to request
the native backend.

## Goal

On macOS, default to the native `webkit` backend. If the user has explicitly
opted into Chromium — by running `bowser install` (which populates
`~/.bowser/chromium/`) or by setting `BOWSER_CHROMIUM_PATH` — use the `chrome`
backend instead. Provide a manual override env var. Leave non-macOS unchanged
(always chrome).

## Backend resolution order

A single pure function `resolveBackend()` is the source of truth:

1. **`BOWSER_BACKEND=webkit|chrome`** — explicit override, wins over everything.
   - Invalid value → clear bowser error.
   - `webkit` on a non-macOS platform → clear bowser error (Bun would throw
     anyway; we pre-empt with a readable message).
2. **macOS + explicit chromium** → `chrome`.
   - "explicit chromium" = `BOWSER_CHROMIUM_PATH` points at an existing file
     **OR** `~/.bowser/chromium/` contains a binary (the bowser-managed cache
     that `bowser install` writes — nothing else writes there).
3. **macOS, otherwise** → `webkit` (native WKWebView).
4. **non-macOS** → `chrome` (unchanged).

| Platform | BOWSER_BACKEND | Explicit chromium (cache/env) | Result |
| --- | --- | --- | --- |
| macOS | unset | no | webkit |
| macOS | unset | yes | chrome |
| macOS | `webkit` | (any) | webkit |
| macOS | `chrome` | (any) | chrome |
| macOS | unset | system Chrome only, no cache/env | webkit (system Chrome ignored as a trigger) |
| linux/win | unset | (any) | chrome |
| linux/win | `webkit` | (any) | error |

## Two separate concerns (kept apart)

- **Selection** — webkit vs chrome, per the rules above.
- **Which chrome binary** — only relevant once `chrome` is selected. Keep the
  existing `detectChromium()` (which *does* include system paths) to find the
  executable; if none is found, pass no path and let Bun discover one. System
  Chrome is a valid *path* even though it is not a valid *trigger*.

This separation is why we need a new narrow predicate `hasExplicitChromium()`
distinct from `detectChromium()`: the trigger must ignore incidental system
Chrome, but the path resolver may still use it.

## Components

- `resolveBackend(env, platform, hasExplicitChromium, detectChromium):
  { kind: 'webkit' } | { kind: 'chrome', path?, argv?, debug? }`
  - Pure. Platform and the two detectors are injectable so it is unit-testable
    without a real browser or filesystem.
- `hasExplicitChromium(): boolean` in `src/browser.ts` — true iff
  `BOWSER_CHROMIUM_PATH` resolves to an existing file or `bowserCacheCandidates()`
  yields an existing file. Reuses the existing cache-scan helpers.
- `openBrowser()` calls `resolveBackend()` and constructs `Bun.WebView`
  accordingly. The hardcoded `"chrome"` literal at browser.ts:42–50 is removed.
  - webkit → `new Bun.WebView({ backend: "webkit", width, height })`.
  - chrome → current behavior (`{ type: "chrome", path?, argv?, ... }`).

## Behavior of existing chrome-only env vars

`BOWSER_CHROME_ARGS` and `BOWSER_CHROME_DEBUG` are **chrome-only tuning** and do
**not** force the backend. When webkit is selected they are silently ignored —
a stray `--no-sandbox` in a shared shell profile must not flip a Mac to chrome.
To force chrome, use `BOWSER_BACKEND=chrome` or `bowser install`.

## Known webkit caveat (documented, not fixed)

WKWebView may not support `screenshot()`. The wrapper already throws
`screenshot: not supported by this Bun.WebView`. We document that screenshots may
require the chrome backend (`BOWSER_BACKEND=chrome` or `bowser install`).
Everything else — `open`, `goto`, `snapshot`, `click`, `fill`, `type`, `press`,
`hover`, `select`, `check` — is expected to work on webkit. No automatic
chrome-fallback for screenshots in this iteration (YAGNI).

## Testing (TDD)

Write tests first, watch them fail, implement minimally.

- New `tests/backend.test.ts` table-driving `resolveBackend()` across:
  `platform ∈ {darwin, linux}` × `cache ∈ {present, absent}` ×
  `BOWSER_CHROMIUM_PATH ∈ {set+exists, unset}` ×
  `BOWSER_BACKEND ∈ {unset, webkit, chrome, invalid}`.
  Uses injected fake `hasExplicitChromium`/`detectChromium` + injected platform —
  no real Chromium, no real fs.
- Assert the error cases: invalid `BOWSER_BACKEND`, and `webkit` on non-macOS.
- Existing e2e tests continue to pass; they pass `BOWSER_CHROMIUM_PATH`, which
  keeps them on the chrome backend (resolution rule 2), so no e2e changes needed.

## Docs

- `README.md`: document `BOWSER_BACKEND` and the macOS-native-by-default behavior,
  including the screenshot caveat.
- `skills/bowser/SKILL.md`: same, in the env/troubleshooting section.
- `AGENTS.md`: add a note under conventions/gotchas that backend selection lives
  in `resolveBackend()` and the cache-vs-system-Chrome trigger distinction.

## Out of scope

- Automatic chrome-fallback for screenshots.
- Changing `detectChromium()`'s system-path list.
- Any change to non-macOS behavior.
