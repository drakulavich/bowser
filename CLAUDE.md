# CLAUDE.md — orientation for AI agents working on this repo

`bowser` is a Bun-native CLI that drives a real headless browser through concise shell commands, **drop-in command-compatible with Microsoft `playwright-cli`** for the core agent loop. Each named session keeps a long-lived browser process so multi-step flows survive between commands.

User docs live in `README.md`, `CHANGELOG.md`, and `skills/bowser/SKILL.md`. This file is for whoever is *modifying* the code.

## Where to look first

| Question | File |
| --- | --- |
| What command does X? | `src/cli.ts` (dispatcher), `src/cli/schemas.ts` (per-command flags), `src/commands.ts` (implementations) |
| How is a flag parsed? | `src/cli/parser.ts` |
| What does the snapshot YAML look like? | `src/snapshot.ts` (`SNAPSHOT_SCRIPT`, `toYaml`, `toJson`) |
| Where is session state? | `src/state.ts` — also `~/.bowser/sessions/<name>/state.json` at runtime |
| Daemon protocol? | `src/daemon.ts` (op union + `handle()`), `src/daemon-main.ts` (entry) |
| WebView / Chromium glue? | `src/browser.ts` |
| Design / plan history? | `docs/superpowers/specs/`, `docs/superpowers/plans/` |

## Build & test

```bash
bun install
bun build src/cli.ts --compile --outfile dist/bowser
# release.yml cross-compiles one binary per target, passing a single
# --target=<t> each: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64

bun test                                       # unit + command tests, fake daemon, no Chromium
BOWSER_E2E=1 bun test                          # + offline e2e against real headless Chromium
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search; brittle)
```

Requires Bun ≥ 1.3.12 — `Bun.WebView` does not exist in 1.3.11, and devs on it hit confusing failures inside the daemon. `engines.bun` and the CI `bun-version` constraints catch this; don't loosen them. Bumping the floor means updating `package.json`, the README, and `test.yml`'s three `bun-version` pins — `release.yml` uses `bun-version: latest` and enforces no floor.

E2E tests redirect `$HOME` to a tmp dir, which hides the bowser-managed Chromium cache. Point at one explicitly:

```bash
BOWSER_E2E=1 \
  BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
  bun test tests/e2e.test.ts tests/e2e-todo.test.ts
```

The e2e job in `test.yml` (push/PR) does the same for CI: `install --force`, locate `chrome-headless-shell`, export `BOWSER_CHROMIUM_PATH`. `release.yml` (on `v*` tags) only cross-compiles, smoke-tests `--help`, and publishes — it runs no browser tests.

## Release

1. Bump `package.json` `version`; add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`.
2. Commit and merge to `main`.
3. `git tag -a vX.Y.Z -m "vX.Y.Z — …" && git push origin vX.Y.Z`.

The workflow then cross-compiles 4 binaries, creates the GitHub Release, and publishes `@drakulavich/bowser-cli` to npm. npm publish **requires repo secret `NPM_TOKEN`** (Granular Access Token, read+write on the package); without it that job alone fails. Fall back to `npm publish --access public` locally only if the workflow is broken.

## Conventions

- **Refs are bare `eN`** (no `@` prefix). `resolveRef` rejects `@`-prefixed input.
- **Snapshot output is aria-tree YAML** matching `playwright-cli` byte-for-byte (no `url:`/`title:` header). `--depth=N` is honored in `toYaml` (`src/snapshot.ts`): default unbounded, `depth=1` reproduces the flat v0.2 output, `depth=0` is a user error. Change nesting there, not in the parser or callers.
- **Exit codes**: `0` success, `1` user error (`usage:`, `unknown command`, `expected a ref`, `ref '...' not found`, `no open page`, `invalid BOWSER_BACKEND`, `BOWSER_BACKEND=webkit`), `2` runtime error. The regex lives in `src/cli.ts`'s `import.meta.main` block — keep error messages aligned with it.
- **Per-command implementations** in `src/commands.ts` use `loadRef(session, ref)` for ref-action commands and `emptyState(name)` for null-state fallbacks.
- **Daemon round-trips are not free** — one Unix socket RTT per `c.request(...)`. `cmdFill` already costs 3 (click → evaluate(clear) → type); collapse if you add a similar command.
- **Bun-native, not Node-native**: prefer `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.connect`. Avoid npm dependencies — the package is intentionally devDep-only.
- **Don't mock the daemon for e2e** — those tests must hit a real WebView. Unit tests use the inline `fakeClient(handlers)` factory in `tests/commands.test.ts`; add new ops to its switch when you introduce daemon ops, and seed refs with `saveState({ ... })`.
- **Backend selection lives in `resolveBackend()`** (`src/browser.ts`). macOS defaults to native `webkit` and switches to `chrome` only on *explicit* opt-in (`hasExplicitChromium()` — bowser cache or `BOWSER_CHROMIUM_PATH`), never on incidental system Chrome. `BOWSER_BACKEND=webkit|chrome` overrides. Keep that trigger distinct from the path resolver `detectChromium()`, which may use system Chrome.
- **TDD for new functionality**: write the test, see it fail, implement minimally, see it pass, commit. Plans live in `docs/superpowers/plans/`.

## Adding a command (e.g. `dblclick`)

1. Add the op to `DaemonRequest["op"]` and `handle()` in `src/daemon.ts`; back it with a `Browser` method in `src/browser.ts`.
2. Add `cmdDblclick` in `src/commands.ts` (use `loadRef` if it takes a ref).
3. Add an entry to `SCHEMAS.commands` in `src/cli/schemas.ts` and a case in `src/cli.ts`'s switch.
4. Add a unit test in `tests/commands.test.ts`.
5. Add a row to the README table and the SKILL.md command reference.
6. Add a line to `DESCRIPTIONS` in `src/mcp.ts` — every non-excluded command is **auto-exposed as an MCP tool** by reflecting over `SCHEMAS.commands`, and `tests/mcp.test.ts` guards that every command has one. Exclude via `MCP_EXCLUDED`. The MCP server must keep **stdout pure** (JSON-RPC only) — never `console.log` from `src/mcp.ts`; it routes through `run()`, which returns a string.

Changing snapshot output means updating `src/snapshot.ts`, the golden in `tests/snapshot.test.ts`, **and** the substring matchers in `tests/e2e*.test.ts` (they assert things like `"Add": [ref=`).

## Gotchas (lessons learned)

- **`JSON.stringify(selector)` is mandatory in evaluate-shims.** `src/browser.ts` and `src/commands.ts` build IIFE strings injected into the page (`document.querySelector(${JSON.stringify(selector)})`). Skipping it is a quoting/injection bug — selectors with quotes could break or execute attacker-controlled code via `bowser fill`.
- **`socket.write()` does partial writes — never ignore its return value.** Bun's low-level socket write returns the bytes actually accepted and silently drops the rest under backpressure (~8 KB on macOS Unix sockets). Route every daemon/client write through `socketWriteAll()` (`src/socket-write.ts`) and keep the `drain` handlers wired in both `Bun.listen` and `Bun.connect`. A raw `socket.write(bigString)` truncates anything over the buffer — that is what made `screenshot` (~140 KB base64) hang for 30 s (#9).
- **`spawnDaemon()` MUST `proc.unref()` the daemon.** Bun holds the parent's event loop open until a spawned child exits, but the daemon runs forever — without `unref()`, `bowser open` on a fresh session prints its result and then hangs. `bun test` masks this entirely (the runner force-exits), so only the compiled-binary CI step catches it; its commands are wrapped in `timeout` because a regression otherwise burns the full 6 h job budget.
- **Compiled-binary daemon spawn re-invokes the binary with `--daemon`.** In a `--compile` binary `import.meta.url` is `file:///$bunfs/root/...`, a virtual path `Bun.spawn` can't execute. `spawnDaemon()` detects it with `import.meta.url.includes("/$bunfs/")` (NOT `startsWith` — the `file://` scheme defeats that) and spawns `[execPath, "--daemon", session]`. `cli.ts` intercepts `--daemon` first thing in `import.meta.main` and calls `startDaemon()` **without** `process.exit()` — the keepalive interval holds the process open, and exiting tears the daemon down the moment its socket is ready. `bun test` never exercises this; the e2e CI job does.
- **Daemon serializes operations.** `startDaemon` runs every request through a promise-chain serializer (`src/serialize.ts`) with a `BOWSER_OP_TIMEOUT_MS` budget, because one `Bun.WebView` cannot handle concurrent `evaluate()` safely. Never reintroduce a bare `handle(req).then(...)` dispatch.
- **`sessionsRoot()` must be call-time, not module-time.** `src/state.ts` resolves it from `process.env.HOME` inside the function body. A module-level snapshot captures the real home before tests redirect `HOME` to a tmp dir, breaking hermeticity. Same pattern as `bowserCacheRoot()`. (Tests redirect `HOME` in `beforeAll` and restore it after, so anything reading `~/...` — including `detectChromium()`'s cache scan — sees the tmp one.)
- **`view.url` returns `about:blank` on chrome after query-string navigations.** The daemon `state` op reports the real URL via `realUrl()`, resolving `location.href` from inside the page. Don't swap `realUrl()` for `view.url`.
- **`Bun.WebView.screenshot()` returns a `Blob`, not base64.** Decode via `pngBytesFrom()` (`src/browser.ts`) — `String(blob)` is `"[object Blob]"`, which silently produced the old 7-byte "PNG". `browser.screenshot()` returns base64, and the daemon (not the CLI) writes the file when `cmdScreenshot` gets an absolute path, so the payload never crosses the socket (#9).
- **Headless-shell binary name.** Playwright names the binary `chrome-headless-shell` on every platform, including inside `chrome-headless-shell-mac-arm64/`. The older `headless_shell` name appears in some docs and was once hardcoded, silently breaking `detectChromium()` on macOS. If you touch `bowserCacheCandidates()`, check the real layout under `~/.bowser/chromium/chromium_headless_shell-*/`.
- **Live-internet e2e is brittle.** `tests/e2e-search.test.ts` drives `github.com` and breaks whenever GitHub renames a CSS class. Never gate a release on it — that is why it sits behind `BOWSER_E2E_NET=1`.
- **`gh auth setup-git` if a push to `.github/workflows/` is rejected.** A default OAuth token without the `workflow` scope refuses workflow file changes; that command switches git's credential helper to gh's scoped token.
- **Squash-merge after local commits on `main` causes divergence.** Resolve with `git reset --hard origin/main`, never a merge.
