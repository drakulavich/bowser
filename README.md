# Bowser

A Bun-native, token-efficient browser automation CLI for AI agents. Bowser fuels your agent with web context — clean, structured, and tiny in the context window.

Built on [`Bun.WebView`](https://bun.com/docs/runtime/webview) (new in Bun 1.3.12), so on macOS there's nothing to install beyond Bun itself, and on Linux / Windows it drives any installed Chrome / Chromium / Edge over the DevTools Protocol.

## Why

Bowser is a **drop-in command-compatible alternative to Microsoft [`playwright-cli`](https://github.com/microsoft/playwright-cli)** for the core agent loop. Same commands, same flag syntax, same snapshot YAML — replace `playwright` with `bowser` and existing playwright-cli skills work unchanged.

What sets it apart:

- **Bun-native.** Single static binary via `bun build --compile`. Fast cold start. No Node / npm / Playwright install dance.
- **Token-efficient.** Capabilities are shell commands, not MCP tool schemas. A skill description of a few hundred tokens covers the whole API.
- **Persistent sessions.** Each named session keeps a long-lived browser process so multi-step flows survive between commands.

## Install

```bash
# From npm (requires Bun ≥ 1.3.12 on your PATH)
npm install -g @drakulavich/bowser-cli

# ...or directly from source
git clone https://github.com/drakulavich/bowser.git
cd bowser
bun install
bun link                     # exposes `bowser` on $PATH
```

Then fetch a headless Chromium into Bowser's own cache (skipped if a system
Chromium is already available):

```bash
bowser install
```

Prebuilt single-file binaries for Linux (x64/arm64) and macOS (arm64/x64)
are also attached to every GitHub Release — see
[Releases](https://github.com/drakulavich/bowser/releases).

Requires Bun ≥ 1.3.12 for the npm/source install.

### How Chromium is resolved

Bowser looks for a Chromium/Chrome binary in this order and uses the first one found:

1. `$BOWSER_CHROMIUM_PATH` (explicit override)
2. `~/.bowser/chromium/...` (populated by `bowser install`)
3. System-wide installs: `/usr/bin/chromium-headless-shell`, `/usr/bin/chromium`, `/usr/bin/google-chrome`, `/Applications/Google Chrome.app/...`, `/Applications/Chromium.app/...`

If none of those exist, run `bowser install`. It uses Playwright's downloader under the hood but writes into Bowser's own cache — it won't touch your Playwright setup. Use `bowser install --force` to re-download even when a system Chrome is already present.

## Quickstart

```bash
bowser open https://example.com          # navigate, save state
bowser snapshot                          # aria-tree YAML with [ref=eN]
bowser click e3                          # click a ref
bowser fill e5 "hello@bowser.dev"        # fill a form field
bowser press Enter                       # submit
bowser screenshot --filename=shot.png    # capture
bowser close                             # end session
```

Each session runs one persistent browser process (spawned lazily on first command, addressed over a Unix socket). Commands attach, run, and detach — so typed text, modals, dynamic DOM, cookies, and auth all survive across invocations. Session state lives under `~/.bowser/sessions/<name>/`.

### Multiple sessions

```bash
bowser -s=login open https://app.example.com/login
bowser -s=login fill  e1 "me@example.com"
bowser -s=login fill  e2 "$PASSWORD"
bowser -s=login click e3
```

### JSON output for agent pipelines

```bash
bowser --json snapshot | jq '.refs[] | select(.role == "button")'
```

## Command reference

| Command | Description |
| --- | --- |
| `install [--force]` | Download a headless Chromium |
| `open [url]` | Start session; navigate if URL given |
| `goto <url>` | Navigate within current session |
| `snapshot [--filename=f]` | aria-tree YAML of interactive refs |
| `click <ref>` | Click an element |
| `fill <ref> <text>` | Focus, clear, type |
| `type <text>` | Type into focused element |
| `press <key>` | Press a keyboard key |
| `hover <ref>` | Hover an element |
| `select <ref> <value>` | Choose a `<select>` option |
| `check <ref>` / `uncheck <ref>` | Toggle a checkbox |
| `screenshot [ref] [--filename=f]` | Full-page or element screenshot |
| `go-back` / `go-forward` / `reload` | Navigation |
| `list` | List sessions |
| `close` | End the current session |

Global flags: `-s=<name>` / `--session=<name>`, `--json`, `-h/--help`.

## How it works

1. `bowser open` spawns a per-session daemon holding a `Bun.WebView`, navigates, and saves `{url, title}` to `~/.bowser/sessions/<name>/state.json`.
2. `bowser snapshot` runs a [snapshot script](./src/snapshot.ts) in the page that walks the DOM, picks interactive elements, computes a stable CSS path (`#id` when safe, otherwise an `nth-of-type` chain), and returns the refs as aria-tree YAML. Refs are persisted so later commands can resolve `e3` → `html > body > button:nth-of-type(2)`.
3. `bowser click e3` resolves the ref from state and dispatches the click via the daemon, using `Bun.WebView`'s built-in actionability auto-wait — no polling, no hard-coded timeouts.

Because selectors are stable paths (not injected `data-` attributes), they survive page reloads between commands.

## Tests

```bash
bun test                                       # unit + command tests with a fake daemon
BOWSER_E2E=1 bun test                          # + end-to-end against real headless Chromium
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search)
```

**End-to-end examples included:**
- `tests/e2e.test.ts` — open/snapshot/click on a `data:` URL (no network)
- `tests/e2e-todo.test.ts` — a local todo app served by `Bun.serve`: add three todos, toggle one, clear completed. Proves the daemon keeps state across commands.
- `tests/e2e-search.test.ts` — live web: search GitHub for OpenClaw, find the repo link, type into the search box and press Enter.

## Build a single binary

```bash
bun build src/cli.ts --compile --outfile dist/bowser
./dist/bowser open https://example.com
```

Cross-compile for other platforms:

```bash
bun build src/cli.ts --compile --target=bun-darwin-arm64 --outfile dist/bowser-macos-arm64
bun build src/cli.ts --compile --target=bun-linux-x64    --outfile dist/bowser-linux-x64
bun build src/cli.ts --compile --target=bun-windows-x64  --outfile dist/bowser.exe
```

## Roadmap

- [x] Persistent session daemon over Unix socket
- [x] playwright-cli command compatibility for the core agent loop
- [ ] Snapshot nesting honoring `--depth=N`
- [ ] Storage commands (`cookie-*`, `localstorage-*`, `state-save`/`load`)
- [ ] Tab management (`tab-list`/`tab-new`/`tab-select`/`tab-close`)
- [ ] Network mocking (`route`, `unroute`)
- [ ] Tracing / video / PDF output
- [ ] `eval`, `run-code`, `dialog-accept`/`dismiss`, `resize`
- [ ] MCP bridge subcommand for non-CLI clients
- [ ] Agent skill published to [agentskills.io](https://agentskills.io)

## License

MIT
