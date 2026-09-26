# Spec: WebKit only — remove the Chrome backend

**Status:** approved, 2026-09-26.
**Origin:** the owner's decision, in their words: "Делаем pivot. Убираем поддержку chrome целиком. Только WebKit",
and the reason: "Для хрома уже есть playwright-cli". bowser's niche is native WebKit through `Bun.WebView`
on macOS, with zero browser downloads. Chromium users already have the reference tool.

## Forced consequences (measured in `bun-types`, Bun 1.4.2)

- **macOS only.** `new Bun.WebView()` with the WebKit backend "throws on non-macOS platforms". Without
  Chrome, bowser cannot run on Linux at all.
- **No cookie API.** `Bun.WebView` exposes cookies only through CDP (`view.cdp`), which exists only on
  the Chrome backend.

## Behaviour after the change

1. **One backend.** bowser always opens a WebKit `Bun.WebView`. `BOWSER_BACKEND` and `BOWSER_CHROMIUM_PATH`
   are gone. If `BOWSER_BACKEND` is set, it is ignored; nothing parses it. Code that only existed for
   Chrome is gone:
   - `src/backend.ts` (`resolveBackend`, `detectChromium`, `hasExplicitChromium`) and `src/cdp/`;
   - `Browser.subscribe`/CDP plumbing, and the `requires: "cdp"` op marker with `CDP_OPS`/`REQUIRES_CDP`;
   - the Chrome dialog path (`watchDialogs`/`answerDialog`/`ANSWER_TIMEOUT_MS`/the `answering` chain/
     `Handler.timedOut`'s dialog part), so the WebKit page shim is the only dialog mechanism;
   - the main-frame lookup, `realUrl()`'s Chrome workaround (if WebKit's `view.url` is correct; measure);
   - the Chrome profile flush (`Browser.close` over CDP plus the `ps` wait);
   - the `goBack`/`goForward` native-method probing, if only Chrome had them (measure on WebKit first).
2. **Non-macOS.** Any command that would start a daemon fails fast on a non-macOS platform with
   `bowser requires macOS (WebKit)` and exit 1 (a user error; add it to the exit-code regex in
   `src/cli.ts`). `--help`, `--version` and the MCP tool listing still work everywhere.
3. **Removed commands:** `install` (downloaded Chromium), and `cookie-list`, `cookie-get`, `cookie-set`,
   `cookie-delete`, `cookie-clear`. Running one gives the ordinary `unknown command` (exit 1).
4. **`state-save` / `state-load` keep only localStorage.** The file format stays Playwright's
   `storageState`: `state-save` writes `"cookies": []` plus per-origin localStorage. `state-load`
   restores localStorage and ignores a non-empty `cookies` array. It does not fail; it prints one
   stderr line saying `N cookies skipped (bowser has no cookie access on WebKit; use open --persistent)`.
   Their summaries lose "(chrome backend only)".
5. **Persistent profiles** (`open --persistent`, `--profile`) stay, on WebKit's `dataStore`. They are
   now the way to keep cookies (logins) between sessions. The README says so.
6. **Distribution.** Release builds only `bun-darwin-arm64` and `bun-darwin-x64`. `package.json` gains
   `"os": ["darwin"]`. The CI unit job runs on macOS only, and the Linux Chromium e2e job is removed.
   The `release.yml` smoke test runs on a macOS runner.
7. **Version 0.6.0**, with a CHANGELOG section headed **BREAKING**. It lists everything removed above
   and points Chromium users to `playwright-cli`.

## Acceptance

1. `bun run typecheck` is clean and `bun test` has 0 failures. No test, source file or doc mentions
   `chrome`/`chromium`/`cdp`/`BOWSER_BACKEND`/`BOWSER_CHROMIUM_PATH`, except the CHANGELOG history, the
   BREAKING note, dated specs/plans (history, left as they are), and the one README pointer to
   `playwright-cli` for Chromium. Add a `tests/layers.test.ts` rule (or extend it) that fails if `src/`
   mentions CDP or Chrome again.
2. `BOWSER_E2E=1 bun test` (WebKit) has 0 failures. Tests that only covered Chrome are deleted, not
   skipped: `e2e-cookie`, `cookie.test`, `install.test`, `backend.test`, the Chrome-only dialog tests,
   and the Chrome halves of the handler tests.
3. Unit tests cover:
   - `state-save` writes `cookies: []` and localStorage;
   - `state-load` restores localStorage and reports skipped cookies;
   - a removed command gives `unknown command` (exit 1);
   - the non-macOS guard gives exit 1 with its message. Test it through a public seam that can fake
     the platform, not by mocking the daemon.
4. `tests/docs-drift.test.ts` passes. README, SKILL.md and CLAUDE.md are rewritten for one backend:
   - README: Install, "Browser backend", "How Chromium is resolved", env vars, Tests, Build, Roadmap;
     the Roadmap's storage line drops cookies.
   - CLAUDE.md: conventions and gotchas that were Chrome-only are removed; ones that still apply to
     WebKit are kept.
5. The compiled binary runs `open`/`snapshot`/`close` on macOS (the CI e2e job does this).

## Out of scope

Any new feature. Cookie access through `document.cookie` (the owner chose to remove cookies). Keeping a
Chrome code path "just in case".
