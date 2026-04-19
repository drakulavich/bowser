# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
