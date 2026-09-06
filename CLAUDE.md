# CLAUDE.md — orientation for AI agents working on this repo

`bowser` is a Bun-native CLI that drives a real headless browser through concise shell commands, **drop-in command-compatible with Microsoft `playwright-cli`** for the core agent loop. Each named session keeps a long-lived browser process so multi-step flows survive between commands.

User docs live in `README.md`, `CHANGELOG.md`, and `skills/bowser/SKILL.md`. This file is for whoever is *modifying* the code.

## Where to look first

| Question | File |
| --- | --- |
| What command does X? | `src/cli/registry.ts` (the `COMMANDS` list), `src/commands/<domain>.ts` (the `Command` objects and their implementations; `context.ts` has what they share) |
| A script injected into the page? | `src/page-scripts.ts` — the only file that builds one |
| How is a flag parsed? | `src/cli/parser.ts` |
| What does the snapshot YAML look like? | `src/snapshot.ts` (`toYaml`, `toJson`); the page-side walker is `SNAPSHOT_SCRIPT` in `src/page-scripts.ts` |
| Where is session state? | `src/state.ts` — also `~/.bowser/sessions/<name>/state.json` at runtime |
| Daemon protocol? | `src/daemon/protocol.ts` (the `DaemonOps` map), `src/daemon/server.ts` (`createHandler`, `startDaemon`), `src/daemon/client.ts` (`DaemonClient`, `connectOrSpawn`), `src/daemon/main.ts` (spawn entry) |
| WebView glue (Browser, cookies, navigation watch)? | `src/browser.ts` (`wrapView`, `openBrowser`) |
| Backend choice / Chromium detection? | `src/backend.ts` (`resolveBackend`, `detectChromium`, `hasExplicitChromium`) |
| Design / plan history? | `docs/superpowers/specs/`, `docs/superpowers/plans/` |

## Build & test

```bash
bun install
bun build src/cli.ts --compile --outfile dist/bowser
# release.yml cross-compiles one binary per target, passing a single
# --target=<t> each: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64

bun run typecheck                              # tsc; bun test strips types and checks nothing
bun test                                       # unit + command tests, fake daemon, no browser
BOWSER_E2E=1 bun test                          # + offline e2e on whichever backend resolves (webkit on macOS)
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test    # + the WebKit agent-loop scenario (macOS)
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search; brittle)
```

`tests/e2e-compat.test.ts` diffs bowser against `playwright-cli` on WebKit and
skips unless `playwright-cli` is in `$PATH` with its WebKit installed
(`playwright-cli install-browser webkit`). It asserts bowser's refs are a
subset of `playwright-cli`'s tree; the formats themselves differ on purpose
until the snapshot-parity task (see the 2026-09-05 refactor spec, "Findings").

Requires Bun ≥ 1.3.12 — `Bun.WebView` does not exist in 1.3.11, and devs on it hit confusing failures inside the daemon. `engines.bun` and the CI `bun-version` constraints catch this; don't loosen them. Bumping the floor means updating `package.json`, the README, and `test.yml`'s four `bun-version` pins — `release.yml` uses `bun-version: latest` and enforces no floor.

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
- **Per-command implementations** live in `src/commands/<domain>.ts` and use the `context.ts` helpers: `withClient`, `loadRef(session, ref)` for ref-action commands, `emptyState(name)` for null-state fallbacks, `reply(ctx, json, text)` for the answer, `syncState(prev, state)` after an action that may navigate.
- **Daemon round-trips are not free** — one Unix socket RTT per `c.request(...)`. `cmdFill` already costs 3 (click → evaluate(clear) → type); collapse if you add a similar command.
- **Bun-native, not Node-native**: prefer `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.connect`. Avoid npm dependencies — the package is intentionally devDep-only.
- **Don't mock the daemon for e2e** — those tests must hit a real WebView. Unit tests use the `fakeClient(handlers)` factory in `tests/helpers/fake-client.ts`; its handlers are typed from `DaemonOps`, so a new op needs no fake change — pass a handler per test only when the default doesn't fit — and seed refs with `saveState({ ... })`.
- **Backend selection lives in `resolveBackend()`** (`src/backend.ts`). macOS defaults to native `webkit` and switches to `chrome` only on *explicit* opt-in (`hasExplicitChromium()` — bowser cache or `BOWSER_CHROMIUM_PATH`), never on incidental system Chrome. `BOWSER_BACKEND=webkit|chrome` overrides. Keep that trigger distinct from the path resolver `detectChromium()`, which may use system Chrome.
- **TDD for new functionality**: write the test, see it fail, implement minimally, see it pass, commit. Plans live in `docs/superpowers/plans/`.
- **Daemon requests are typed.** `c.request("state")` returns `PageState`; do not cast results. A new op needs an entry in `DaemonOps` and a handler in `server.ts`; `tests/helpers/fake-client.ts` picks it up automatically.
- **The registry is the source of truth for what commands exist.** `src/cli/registry.ts` concatenates each `commands/<domain>.ts`'s `COMMANDS`; `SCHEMAS`, `--help` and the MCP tool list are all derived from it, and `tests/docs-drift.test.ts` checks README and SKILL.md against it in both directions: a command with no doc row fails, and so does a `bowser <name>` the docs still show after the command was renamed or removed. A command's `summary` is one line, imperative, no trailing period: it is both its help text and its MCP description.

## Adding a command (e.g. `dblclick`)

1. Add the op to `DaemonOps` in `src/daemon/protocol.ts` and a handler to the `handlers` table in `src/daemon/server.ts` (tsc fails until both exist); back it with a `Browser` method in `src/browser.ts`. If the op needs CDP, add `requires: "cdp"` to its `DaemonOps` entry and a row to `CDP_OPS` in the same file. If the op must answer while another op is wedged (like `shutdown`), add `urgent: true` to its `DaemonOps` entry and a row to `URGENT_OPS`; it then skips the serializer. A new page script goes in `src/page-scripts.ts`.
2. Add `cmdDblclick` in the `src/commands/<domain>.ts` it belongs to (`interaction.ts` here; use `loadRef` if it takes a ref, `reply` for the answer), and a `Command` entry in that file's `COMMANDS` array with its `summary`, positionals and flags. Dispatch, `--help` and the MCP tool follow automatically.
3. Add a unit test in `tests/commands.test.ts`.
4. Add a row to the README table and the SKILL.md command reference — `tests/docs-drift.test.ts` fails until you do.

Changing snapshot output means updating `src/snapshot.ts`, the golden in `tests/snapshot.test.ts`, **and** the substring matchers in `tests/e2e*.test.ts` (they assert things like `"Add": [ref=`).

## Gotchas (lessons learned)

- **`JSON.stringify(selector)` is mandatory in evaluate-shims.** `src/page-scripts.ts` builds every string injected into the page (`document.querySelector(${JSON.stringify(selector)})`), and a layer rule keeps them out of every other file. Skipping the quoting is a quoting/injection bug — selectors with quotes could break or execute attacker-controlled code via `bowser fill`.
- **`socket.write()` does partial writes — never ignore its return value.** Bun's low-level socket write returns the bytes actually accepted and silently drops the rest under backpressure (~8 KB on macOS Unix sockets). Route every daemon/client write through `socketWriteAll()` (`src/socket-write.ts`) and keep the `drain` handlers wired in both `Bun.listen` and `Bun.connect`. A raw `socket.write(bigString)` truncates anything over the buffer — that is what made `screenshot` (~140 KB base64) hang for 30 s (#9).
- **`spawnDaemon()` MUST `proc.unref()` the daemon.** Bun holds the parent's event loop open until a spawned child exits, but the daemon runs forever — without `unref()`, `bowser open` on a fresh session prints its result and then hangs. `bun test` masks this entirely (the runner force-exits), so only the compiled-binary CI step catches it; its commands are wrapped in `timeout` because a regression otherwise burns the full 6 h job budget.
- **Compiled-binary daemon spawn re-invokes the binary with `--daemon`.** In a `--compile` binary `import.meta.url` is `file:///$bunfs/root/...`, a virtual path `Bun.spawn` can't execute. `spawnDaemon()` detects it with `import.meta.url.includes("/$bunfs/")` (NOT `startsWith` — the `file://` scheme defeats that) and spawns `[execPath, "--daemon", session]`. `cli.ts` intercepts `--daemon` first thing in `import.meta.main` and calls `startDaemon()` **without** `process.exit()` — the keepalive interval holds the process open, and exiting tears the daemon down the moment its socket is ready. `bun test` never exercises this; the e2e CI job does.
- **Daemon serializes operations, except the urgent lane.** `dispatch()` (`src/daemon/server.ts`) runs every queued request through a promise-chain serializer (`src/serialize.ts`) with a `BOWSER_OP_TIMEOUT_MS` budget, because one `Bun.WebView` cannot handle concurrent `evaluate()` safely. An op marked `urgent: true` in `DaemonOps` (`ping`, `shutdown`) skips the serializer on purpose — that is what lets it answer while another op is wedged. Don't add a bare `handle(req).then(...)` dispatch for a non-urgent op.
- **The WebView has two unrelated event mechanisms.** `onNavigated`/`onNavigationFailed` are assignable properties, and `wrapView` owns both for the navigation watch — assigning over either silently breaks `nav.act()`. Backend events (CDP event names on chrome) come through `addEventListener` instead, which is what `Browser.subscribe()` wraps. On webkit `addEventListener` accepts the registration and never fires, so `subscribe()` returns `false` there rather than reporting a success that delivers nothing.
- **`sessionsRoot()` must be call-time, not module-time.** `src/state.ts` resolves it from `process.env.HOME` inside the function body. A module-level snapshot captures the real home before tests redirect `HOME` to a tmp dir, breaking hermeticity. Same pattern as `bowserCacheRoot()`. (Tests redirect `HOME` in `beforeAll` and restore it after, so anything reading `~/...` — including `detectChromium()`'s cache scan — sees the tmp one.)
- **`view.url` returns `about:blank` on chrome after query-string navigations.** The daemon `state` op reports the real URL via `realUrl()`, resolving `location.href` from inside the page. Don't swap `realUrl()` for `view.url`.
- **`Bun.WebView.screenshot()` returns a `Blob`, not base64.** Decode via `pngBytesFrom()` (`src/browser.ts`) — `String(blob)` is `"[object Blob]"`, which silently produced the old 7-byte "PNG". `browser.screenshot()` returns base64, and the daemon (not the CLI) writes the file when `cmdScreenshot` gets an absolute path, so the payload never crosses the socket (#9).
- **Headless-shell binary name.** Playwright names the binary `chrome-headless-shell` on every platform, including inside `chrome-headless-shell-mac-arm64/`. The older `headless_shell` name appears in some docs and was once hardcoded, silently breaking `detectChromium()` on macOS. If you touch `bowserCacheCandidates()`, check the real layout under `~/.bowser/chromium/chromium_headless_shell-*/`.
- **Live-internet e2e is brittle.** `tests/e2e-search.test.ts` drives `github.com` and breaks whenever GitHub renames a CSS class. Never gate a release on it — that is why it sits behind `BOWSER_E2E_NET=1`.
- **`gh auth setup-git` if a push to `.github/workflows/` is rejected.** A default OAuth token without the `workflow` scope refuses workflow file changes; that command switches git's credential helper to gh's scoped token.
- **Squash-merge after local commits on `main` causes divergence.** Resolve with `git reset --hard origin/main`, never a merge.
- **`Bun.WebView` history methods are `goBack()`/`goForward()` at runtime.** `@types/bun` declares `back()`/`forward()`, which are `undefined` on the object (Bun 1.4.0). `ViewLike` in `src/browser.ts` names the runtime methods and probes them with `typeof`; do not rename them to match the types. tsc will not save you: renaming only the call sites fails, but renaming `ViewLike` too compiles clean, because these members are optional and probed with `typeof` — tsc never checks the names against anything. At runtime the probe then fails and both silently fall through to the `history.back()` fallback meant for webkit, so nothing throws and the chrome backend quietly changes behaviour.
- **Actions that can navigate go through `nav.act()`.** `click`, `press`, `back`, `forward` and `reload` wait for a navigation that begins within 100 ms and let it land (10 s cap) before returning; that is why `state` right after `click` reports the new URL. A new action that may trigger a navigation must be wrapped the same way, or its reported URL will be stale.
- **The daemon's `shutdown` exit is a macrotask (`setTimeout(..., 0)`), never a microtask.** The reply is written from a promise continuation; a `queueMicrotask` exit ran before it once `Browser.close()` stopped awaiting anything, and every `close` hung for the client's timeout. `tests/daemon-handler.test.ts` pins reply-before-exit.
- **The MCP server must keep stdout pure (JSON-RPC only).** Every command's tool call routes through `run()`, which returns a string — never `console.log` from `src/mcp.ts`.
