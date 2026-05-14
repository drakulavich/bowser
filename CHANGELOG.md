# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Changed

- The snapshot script returns a `path` array per ref (landmark ancestors,
  root-most first). `Ref.path` is optional in `state.json`; older state
  files without it remain valid and render flat.

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
