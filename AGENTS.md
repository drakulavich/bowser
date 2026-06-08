# AGENTS.md — orientation for AI agents working on this repo

`bowser` is a Bun-native CLI that drives a real headless browser through concise shell commands. The CLI surface is **drop-in command-compatible with Microsoft `playwright-cli`** for the core agent loop. Each named session keeps a long-lived browser process so multi-step flows survive between commands.

Public API: the 18 commands listed in `README.md`. User docs live in `README.md`, `CHANGELOG.md`, and `skills/bowser/SKILL.md`. This file is for whoever is *modifying* the code.

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

## Build

```bash
bun install
bun build src/cli.ts --compile --outfile dist/bowser
./dist/bowser --help
```

Cross-compile (used in the release workflow):

```bash
bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile dist/bowser-macos-arm64
bun build src/cli.ts --compile --target=bun-linux-x64    --outfile dist/bowser-linux-x64
bun build src/cli.ts --compile --target=bun-darwin-x64   --outfile dist/bowser-macos-x64
bun build src/cli.ts --compile --target=bun-linux-arm64  --outfile dist/bowser-linux-arm64
```

Requires Bun ≥ 1.3.12 (for `Bun.WebView`).

## Tests

```bash
bun test                                       # unit + command tests, fake daemon, no Chromium
BOWSER_E2E=1 bun test                          # + offline e2e against real headless Chromium
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search; brittle)
```

E2E tests redirect `$HOME` to a tmp dir, which makes the bowser-managed Chromium cache invisible. To run e2e against a system or cached Chromium, pass it explicitly:

```bash
BOWSER_E2E=1 \
  BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
  bun test tests/e2e.test.ts tests/e2e-todo.test.ts
```

Test layout:

- `tests/state.test.ts` — `resolveRef` + `saveState`/`loadState` roundtrip (real fs, tmp HOME).
- `tests/snapshot.test.ts` — golden tests for the aria-tree YAML emitter and `--json` shape.
- `tests/parse-args.test.ts` — schema-driven parser cases.
- `tests/compat.test.ts` — table of `playwright-cli`-style invocations that must parse without error.
- `tests/commands.test.ts` — every command, exercised via an inline `fakeClient(handlers)` helper. Each test seeds session state with `saveState({ ... })` if it needs refs.
- `tests/install.test.ts` — `cmdInstall` skip/force paths with injected `detect`/`spawn`.
- `tests/e2e*.test.ts` — gated on `BOWSER_E2E=1`; need a real Chromium.

When you change the snapshot output, update both the golden in `tests/snapshot.test.ts` and the matchers in the e2e tests (they assert substrings like `"Add": [ref=`).

## CI

Two workflows:

| File | When | What |
| --- | --- | --- |
| `.github/workflows/test.yml` | push to `main`, every PR, `workflow_dispatch` | Unit on Ubuntu+macOS, single-binary build, e2e against bundled Chromium. |
| `.github/workflows/release.yml` | push tag `v*`, `workflow_dispatch` | Cross-compile 4 targets, create GitHub Release with binaries, publish to npm. |

The e2e job runs `bowser install --force` so the bowser-managed cache always exists, then locates `chrome-headless-shell` and exports it as `BOWSER_CHROMIUM_PATH` for the test steps.

## Release

Cutting a version:

1. Bump `package.json` `version`.
2. Add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`.
3. Commit and merge to `main`.
4. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z — …" && git push origin vX.Y.Z`.

The `release` workflow then:

1. Builds 4 single-file binaries (linux x64/arm64, darwin x64/arm64).
2. Creates a GitHub Release at `https://github.com/drakulavich/bowser/releases/tag/vX.Y.Z` with the binaries attached.
3. Publishes to npm as `@drakulavich/bowser-cli@x.y.z` — **requires repo secret `NPM_TOKEN`** (Granular Access Token with read+write on the package). If absent, this job fails (the rest succeed).

To publish manually if the npm step ever fails:

```bash
npm whoami            # confirm logged in as drakulavich
npm publish --access public --dry-run
npm publish --access public
```

## Conventions

- **Refs are bare `eN`** (no `@` prefix). `resolveRef` rejects `@`-prefixed input.
- **Snapshot output is aria-tree YAML** matching `playwright-cli` byte-for-byte (no `url:`/`title:` header). The `--depth=N` flag is parsed but flat in v0.2 — fix the parser, not callers, when implementing nesting.
- **Per-command implementations** in `src/commands.ts` use `loadRef(session, ref)` for ref-action commands and `emptyState(name)` for null-state fallbacks. Keep new commands consistent.
- **Daemon round-trips are not free**: a Unix socket RTT per `c.request(...)`. `cmdFill` currently does 3 (click → evaluate(clear) → type); collapse if you add a similar command.
- **Exit codes**: `0` success, `1` user error (`usage:`, `unknown command`, `expected a ref`, `ref '...' not found`, `no open page`), `2` runtime error. The regex lives in `src/cli.ts`'s `import.meta.main` block — keep error messages aligned.
- **TDD discipline** for new functionality: write the test, see it fail, implement minimally, see it pass, commit. Plans live in `docs/superpowers/plans/`.
- **Don't mock the daemon for e2e** — those tests must hit a real WebView. Unit tests use the inline `fakeClient` helper.
- **Bun-native, not Node-native**: prefer `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.connect`. Avoid adding npm dependencies; the package is intentionally devDep-only.
- **Backend selection lives in `resolveBackend()`** (`src/browser.ts`). macOS
  defaults to native `webkit`; it switches to `chrome` only on *explicit* opt-in
  (`hasExplicitChromium()` — bowser cache or `BOWSER_CHROMIUM_PATH`), never on
  incidental system Chrome. `BOWSER_BACKEND=webkit|chrome` overrides. Keep the
  trigger (cache/env) distinct from the chrome *path* resolver (`detectChromium()`,
  which may use system Chrome).

## Common tasks

**Add a new command** (e.g. `dblclick`):

1. Add a daemon op in `src/daemon.ts` `DaemonRequest["op"]` union and `handle()` switch; back it with a `Browser` method in `src/browser.ts`.
2. Add a `cmdDblclick` in `src/commands.ts` (use `loadRef` if it takes a ref).
3. Add an entry in `SCHEMAS.commands` in `src/cli/schemas.ts` and a case in `src/cli.ts`'s switch.
4. Add a unit test in `tests/commands.test.ts` (extend `fakeClient` if needed).
5. Add a row to the README table and the SKILL.md command reference.

**Change snapshot output**: edit `src/snapshot.ts`, update the golden in `tests/snapshot.test.ts`, then update `tests/e2e*.test.ts` substring matchers.

**Bump Bun requirement**: `package.json` `engines.bun`, README install instructions, both workflow `setup-bun` `bun-version` constraints.

## Gotchas (lessons learned)

- **Headless-shell binary name.** Playwright's distribution names the binary `chrome-headless-shell` on every platform, including `chrome-headless-shell-mac-arm64/`. An older `headless_shell` filename appears in some docs and was previously hardcoded — `detectChromium()` silently failed on macOS as a result. If you touch `bowserCacheCandidates()`, check the actual layout under `~/.bowser/chromium/chromium_headless_shell-*/`.
- **`JSON.stringify(selector)` is mandatory in evaluate-shims.** `src/browser.ts` and `src/commands.ts` build small IIFE strings injected into the page (`document.querySelector(${JSON.stringify(selector)})`). Skipping `JSON.stringify` introduces a quoting/injection bug — selectors with quotes in attribute values would break or execute attacker-controlled code via `bowser fill`.
- **`gh auth setup-git` if push to `.github/workflows/` is rejected.** A default OAuth token without the `workflow` scope refuses to push workflow file changes (`refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`). `gh auth setup-git` switches git's credential helper to gh's scoped token.
- **Squash-merge after local commits on `main` causes divergence.** If you committed to local `main` before branching (e.g. design/plan docs), squash-merging the branch produces a single commit on `origin/main` that subsumes them. Local `main` will diverge. Resolve with `git reset --hard origin/main`, not a merge.
- **Test fixtures pattern.** `tests/commands.test.ts` defines an inline `fakeClient(handlers)` factory at the top — no separate `tests/fixtures/fake-daemon.ts`. Tests that need refs seed them via `saveState({ name: session, refs: [...], ... })` per test. Add new ops to `fakeClient`'s switch when introducing daemon ops.
- **Tests redirect `process.env.HOME`** to a tmp dir via `beforeAll`, then restore it. This means anything that reads `~/...` (including `detectChromium`'s cache scan) sees the tmp HOME. Use `BOWSER_CHROMIUM_PATH` to bypass.
- **Live-internet e2e is brittle.** `tests/e2e-search.test.ts` drives `github.com` and breaks when GitHub renames a CSS class or changes search box markup. Don't gate releases on it; gated behind `BOWSER_E2E_NET=1` for that reason.
- **Bun version 1.3.11 vs 1.3.12.** `Bun.WebView` only exists in ≥ 1.3.12. Local devs on 1.3.11 will hit confusing failures inside the daemon. The `engines.bun` and CI `bun-version` constraints catch this; don't loosen them.
- **Daemon serializes operations.** `startDaemon` in `src/daemon.ts` runs every incoming request through a promise-chain serializer (`src/serialize.ts`) with a `BOWSER_OP_TIMEOUT_MS` budget. A single `Bun.WebView` cannot handle concurrent `evaluate()` calls safely. Do not reintroduce a bare `handle(req).then(...)` dispatch; always route through the serializer.
- **`sessionsRoot()` must be call-time, not module-time.** `src/state.ts` resolves the sessions root from `process.env.HOME` inside the function body (`sessionsRoot()`), not in a module-level `const`. A module-level snapshot captures the real home before test `beforeAll` hooks redirect `process.env.HOME` to a tmp dir, breaking test hermeticity. Mirrors the same pattern as `bowserCacheRoot()`.
- **`view.url` returns `about:blank` on chrome after query-string navigations.** The daemon `state` op reports the real URL via `realUrl()`, which resolves `location.href` from inside the page instead of trusting `Bun.WebView`'s `view.url` getter. Don't replace `realUrl()` calls with `view.url` reads.
- **`Bun.WebView.screenshot()` returns a `Blob`, not a base64 string.** Decode it
  via `pngBytesFrom()` (`src/browser.ts`) — `String(blob)` is `"[object Blob]"`,
  which silently produced the old 7-byte "PNG". `browser.screenshot()` returns
  base64; the daemon (not the CLI) writes the PNG file when `cmdScreenshot` passes
  an absolute path, so the large payload never crosses the socket (see #9).
- **`socket.write()` does partial writes — never ignore its return value.** Bun's
  low-level socket `write()` returns the bytes actually accepted and silently drops
  the rest under backpressure (~8 KB send buffer on macOS Unix sockets). Route every
  daemon/client socket write through `socketWriteAll()` (`src/socket-write.ts`) and
  keep the `drain` handlers wired in both `Bun.listen` and `Bun.connect`. A raw
  `socket.write(bigString)` truncates any payload over the buffer size — this is what
  made `screenshot` (a ~140 KB base64 PNG) hang for 30 s before timing out (#9).
- **Compiled-binary daemon spawn re-invokes the binary with `--daemon`.** In a
  `bun build --compile` binary, `import.meta.url` is `file:///$bunfs/root/...` — a
  virtual path `Bun.spawn` can't execute. `spawnDaemon()` detects this with
  `import.meta.url.includes("/$bunfs/")` (NOT `startsWith`, the `file://` scheme
  defeats it) and spawns `[execPath, "--daemon", session]`; `cli.ts` intercepts
  `--daemon` as the first thing in `import.meta.main` and calls `startDaemon()`
  WITHOUT `process.exit()` (the keepalive interval holds the process open — exiting
  tears the daemon down the instant its socket is ready). `bun test` runs in-process
  and never exercises this path; the e2e CI job drives the real binary to guard it.
