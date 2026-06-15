# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-06-15

### Added

- **`eval <expression>`** — evaluate a JS expression in the current page and print the result.
  String results are printed as-is; other values are `JSON.stringify`'d; `undefined`/`null` prints nothing.
  `--json` wraps output in `{ ok, result }`. Uses the existing `evaluate` daemon op; no new protocol op needed.
- **`run-code <code>`** — run multi-statement JS in the current page by wrapping the user code in an
  IIFE (`(() => { <code> })()`), enabling `return` statements and variable declarations. Same output rules as `eval`.
- **`cookie-list [--domain=<d>] [--url=<u>]`** — list all cookies for the current page (default) or a
  specified scope. Text mode: `name=value` per line; `--json` returns the full CDP shape including all
  attributes. **HttpOnly cookies are first-class** — they are visible and indistinguishable from ordinary
  cookies (unlike `document.cookie`, which hides them). Requires the chrome backend.
- **`cookie-get <name> [--domain=<d>] [--url=<u>]`** — print a cookie's value (empty string if not found).
  `--json` returns `{ ok, cookie }` (full CDP shape) or `{ ok: false }`. HttpOnly cookies are visible.
  Requires the chrome backend.
- **`cookie-set <name> <value> [--domain=<d>] [--url=<u>] [--path=<p>] [--http-only] [--secure] [--same-site=Lax|Strict|None] [--expires=<unix-s>]`** — set one cookie.
  Defaults `--url` to the current page URL when neither `--domain` nor `--url` is given.
  `--http-only` sets the HttpOnly flag (the cookie will be invisible to `document.cookie`).
  Requires the chrome backend.
- **`cookie-delete <name> [--domain=<d>] [--url=<u>] [--path=<p>]`** — delete matching cookie(s).
  Requires the chrome backend.
- **`cookie-clear`** — wipe all browser cookies in the current session's Chrome profile.
  Requires the chrome backend.
- **`src/cdp/types.ts`** — `Cookie`, `CookieParam`, `DeleteCookieOptions` types mirroring the
  CDP Network domain; no runtime dependency.
- **`Browser.cdp()` / `Browser.cdpAvailable()`** — raw CDP access exposed on the `Browser`
  interface in `src/browser.ts`. Delegates to `Bun.WebView.cdp()` on the chrome backend; rejects
  with a clear error on webkit. Future CDP-based commands (tab management, network mocking, etc.)
  build on these methods.

  Implementation note: the design spec proposed a bespoke `src/cdp/client.ts` WebSocket transport
  and `src/cdp/launch.ts` stderr-scraper. At implementation time Bun 1.3.13's `Bun.WebView` was
  found to launch Chrome with `--remote-debugging-pipe` (no stderr `DevTools listening on ws://` line,
  no stderr hook API) and to expose `view.cdp()` natively. The bespoke transport was therefore
  unnecessary; `view.cdp()` is the supported path. The spec doc was updated accordingly.

## [0.3.0] — 2026-06-09

### Added

- `localstorage-list`, `localstorage-get`, `localstorage-set`,
  `localstorage-delete`, `localstorage-clear` — read and write the current
  page's `localStorage` from the CLI. Implemented via `evaluate` against the
  live page; selectors and values are JSON-escaped before injection.
- `sessionstorage-list`, `sessionstorage-get`, `sessionstorage-set`,
  `sessionstorage-delete`, `sessionstorage-clear` — same shape as the
  `localstorage-*` commands, targeting `sessionStorage`. Internally the
  two areas share a single storage helper in `src/commands.ts`.
- `bowser snapshot` now renders landmark nesting (`main`, `navigation`,
  `header`, `footer`, `section`, `article`, `aside`, `form`, `dialog`,
  `list`, `region`, …) as parent nodes in the aria-tree YAML.
- `--depth=N` is honored: `--depth=1` reproduces the flat v0.2 output;
  `--depth=2` keeps only the outermost landmark; default (omitted) is
  unbounded. `--depth=0` is rejected as a user error.
- **`close --all`** (`#7`): closes every open session in one command.
- **`BOWSER_OP_TIMEOUT_MS`** environment variable: sets the per-operation
  timeout in milliseconds (default `30000`; `0` disables). Useful when
  automating slow pages that would otherwise hang indefinitely.

### Changed

- The snapshot script returns a `path` array per ref (landmark ancestors,
  root-most first). `Ref.path` is optional in `state.json`; older state
  files without it remain valid and render flat.

### Fixed

- **Daemon operation serialization** (`#1`/`#3`/`#4`): the daemon now runs
  all operations one at a time through a promise-chain serializer
  (`src/serialize.ts`). Concurrent `evaluate()` calls into the single
  `Bun.WebView` no longer race or deadlock. A per-op timeout (controlled by
  `BOWSER_OP_TIMEOUT_MS`, default 30 s) surfaces wedged operations as a
  clear error instead of hanging.
- **`close [name]`** (`#6`): the positional session name is now honoured —
  `bowser close other-session` closes the named session rather than
  defaulting to `--session`.
- **`goto`/`open` URL reporting** (`#5`): on the chrome backend,
  `view.url` was returning `about:blank` even after a successful
  query-string navigation. The daemon now resolves the real URL via
  `location.href` (`realUrl()`) and fails loud when the page genuinely did
  not load.
- **Test hermeticity**: `sessionsRoot()` in `src/state.ts` now reads
  `process.env.HOME` at call time (matching `bowserCacheRoot()`), so tests
  that redirect `$HOME` via `process.env.HOME` see the temporary directory
  correctly.
- **`screenshot` now writes a valid PNG** (`#2`): decode the `Blob`
  returned by `Bun.WebView.screenshot()` (the old code stringified it to
  `"[object Blob]"`); the CLI writes the file so a relative `--filename`
  resolves against the user's cwd; default name auto-increments.
- **`shutdown` bypasses the op serializer** so `close` always works
  against a stuck daemon even when an operation is wedged in the serializer.
- **`socketPath` reuses `sessionsRoot()`** (`src/daemon.ts`) instead of
  re-computing the sessions root independently.
- **`screenshot` no longer hangs** (`#9`): the daemon ignored Bun's
  partial-write socket contract, so any response larger than the ~8 KB send
  buffer (a ~140 KB base64 PNG) was truncated mid-flight and the client hung
  until timeout. Socket writes now buffer the unsent remainder and flush it on
  `drain` (`src/socket-write.ts`), fixing every command in both directions
  (large snapshots and `localstorage`/`fill` values too). Screenshots are
  additionally written daemon-side and only the path is returned, keeping the
  PNG payload off the socket entirely.
- **Compiled-binary daemon spawn** (`#9`): a `bun build --compile` binary
  could not start its daemon — `import.meta.url` is a virtual `/$bunfs/` path
  that `Bun.spawn` cannot execute. The binary now re-invokes itself with a
  hidden `--daemon` flag. This path was never exercised by `bun test` (which
  runs in-process); a CI step now drives the real binary end-to-end.
- **Daemon-spawning commands no longer hang** (`#9`): `spawnDaemon()` never
  `unref()`'d the detached daemon subprocess, so Bun kept the parent CLI's event
  loop open waiting for a child that runs forever — `bowser open` on a fresh
  session printed its result and then hung instead of returning to the shell.
  `bun test` masked it (the runner force-exits); the real binary did not. The
  spawned process is now unref'd, and the compiled-binary CI step wraps each
  command in `timeout` so a regression fails fast instead of burning the job.

## [0.2.0] — 2026-04-26

### Breaking

- CLI surface is now command-compatible with Microsoft `playwright-cli` for the core agent loop. Existing `playwright-cli` skills work after replacing the binary name.
- `bowser snap` is renamed `bowser snapshot`.
- `bowser session show` and `bowser session list` are replaced by `bowser list`.
- The `@` ref prefix is dropped: refs are now bare `eN` (e.g., `bowser click e3`).
- `-i` / `--interactive` flag removed (snapshot output is always the aria-tree YAML).
- Snapshot YAML changed: aria-tree style with `[ref=eN]` markers.

### Added

- New commands: `goto`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `screenshot`, `go-back`, `go-forward`, `reload`.
- `--filename=path` for `snapshot` and `screenshot`.
- Long-form `--session=<name>` accepted alongside short form `-s=<name>`.

### Migration

| 0.1.0 | 0.2.0 |
|---|---|
| `bowser snap -i` | `bowser snapshot` |
| `bowser click @e3` | `bowser click e3` |
| `bowser --session app open …` | `bowser -s=app open …` |
| `bowser session list` | `bowser list` |
| `bowser session show` | (gone) — use `bowser list` plus `cat ~/.bowser/sessions/<n>/state.json` |

## [0.1.0] — 2026-04-19

First tagged release. An opinionated, Bun-native browser automation CLI for
AI agents.

### Added

- **Daemon architecture.** Each session runs a persistent `Bun.WebView`
  addressed over a Unix socket, so typed text, modals, cookies, and dynamic
  DOM survive across CLI invocations.
- **Core commands:** `bowser open`, `snap`, `click`, `fill`, `close`,
  `session [list|show]`.
- **`bowser install`.** Downloads a headless Chromium into
  `~/.bowser/chromium/` (delegating to Playwright's downloader but routing
  output into Bowser's own cache — no implicit scanning of your Playwright
  install). Skips if a Chromium is already found on the system; use
  `--force` to re-download.
- **Ref-based snapshots.** `bowser snap` tags interactive elements with
  `@e1`, `@e2`, … and persists **stable CSS paths** that survive reloads.
- **YAML + JSON output.** Human-readable by default, `--json` for agent
  pipelines.
- **Multi-session support** via `--session <name>`.
- **End-to-end examples.**
  - `tests/e2e.test.ts` — `data:` URL smoke test (no network).
  - `tests/e2e-todo.test.ts` — a local todo app served by `Bun.serve`,
    proving the daemon keeps state across `click` / `fill` commands.
  - `tests/e2e-search.test.ts` — live web: searches GitHub for OpenClaw and
    finds the repo link (gated behind `BOWSER_E2E_NET=1`).
- **CI** on GitHub Actions (unit + e2e jobs, Ubuntu).
- **Release workflow** that cross-compiles single-file binaries for
  Linux x64, macOS arm64, and macOS x64 on every `v*` tag push.
- **Bowser skill** (`skills/bowser/SKILL.md`) so agents can discover when to
  use Bowser without any MCP server.

### Notes

- Requires Bun ≥ 1.3.12 (for `Bun.WebView`).
- `bowser install` needs internet access and `bunx` on PATH.
- macOS uses system WebKit via `Bun.WebView` — nothing extra to install.
