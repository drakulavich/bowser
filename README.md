# Bowser

[![test](https://github.com/drakulavich/bowser/actions/workflows/test.yml/badge.svg)](https://github.com/drakulavich/bowser/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@drakulavich/bowser-cli.svg)](https://www.npmjs.com/package/@drakulavich/bowser-cli)

A Bun-native, drop-in command-compatible alternative to Microsoft [`playwright-cli`](https://github.com/microsoft/playwright-cli) for AI agents. Same commands, same flag syntax, same snapshot YAML — replace `playwright` with `bowser` and existing playwright-cli skills work unchanged.

Built on [`Bun.WebView`](https://bun.com/docs/runtime/webview) (new in Bun 1.3.12), so on macOS there's nothing to install beyond Bun itself, and on Linux / Windows it drives any installed Chrome / Chromium / Edge over the DevTools Protocol.

## Why

What sets it apart from `playwright-cli`:

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

### Browser backend

On macOS, bowser uses the native `WKWebView` engine by default — nothing to install.
It switches to Chrome/Chromium automatically if you opted in by running
`bowser install` (which caches a headless Chromium under `~/.bowser/chromium`) or by
setting `BOWSER_CHROMIUM_PATH`. On Linux and Windows it always uses Chrome/Chromium.

Override the choice with `BOWSER_BACKEND`:

| Value | Effect |
| --- | --- |
| `BOWSER_BACKEND=webkit` | Force native WebKit (macOS only; errors elsewhere). |
| `BOWSER_BACKEND=chrome` | Force Chrome/Chromium. |

Screenshots are written as PNG files. `bowser screenshot --filename out.png` writes
to `out.png` (relative paths resolve against your current directory); without
`--filename` it writes `screenshot-<session>.png`, auto-incrementing (`-1`, `-2`, …)
if that file already exists. Captures are full-page (element-bounded screenshots are
not supported yet).

### How Chromium is resolved

Bowser looks for a Chromium/Chrome binary in this order and uses the first one found:

1. `$BOWSER_CHROMIUM_PATH` (explicit override)
2. `~/.bowser/chromium/...` (populated by `bowser install`)
3. System-wide installs: `/usr/bin/chromium-headless-shell`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`, `/Applications/Google Chrome.app/...`, `/Applications/Chromium.app/...`

If none of those exist, run `bowser install`. It uses Playwright's downloader under the hood but writes into Bowser's own cache — it won't touch your Playwright setup. Use `bowser install --force` to re-download even when a system Chrome is already present.

## Quickstart

```bash
bowser open https://example.com          # navigate, save state
bowser snapshot                          # the page's aria tree, with [ref=eN]
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
op read op://vault/app/password | bowser -s=login fill e2 --stdin
bowser -s=login click e3
```

### Persistent profiles

A session's browser store is in memory by default: `close` (or a crash) loses its logins. Open it with `--persistent` to keep cookies, `localStorage` and IndexedDB on disk, like `playwright-cli open --persistent`:

```bash
bowser -s=app open https://app.example.com/login --persistent   # profile in ~/.bowser/profiles/app/
bowser -s=app close                                              # the profile stays
bowser -s=app open https://app.example.com --persistent         # still logged in
bowser -s=work open https://app.example.com --profile=./profiles/work   # a directory of your choice
```

- The profile lives outside `~/.bowser/sessions/<name>/`, so `close` leaves it alone. Delete it with `rm -rf ~/.bowser/profiles/<name>` (or your `--profile` directory).
- The store is chosen when the session's browser starts. `open --persistent` on a session that is already running with another store fails with exit 1; run `bowser close` first. `open` without the flag reuses a running persistent session.
- One profile directory serves one running session at a time; sharing it between two is unsupported.
- WebKit needs macOS 15.2 or later for a persistent store.

### Dialogs

bowser answers every `alert`, `confirm` and `prompt` the moment it opens, so no command ever waits on a dialog. Without an answer set, the dialog is dismissed: `confirm` returns `false` and `prompt` returns `null`. To accept one, set the answer **before** the action that opens it:

```bash
bowser dialog-accept            # the next dialog is accepted (confirm → true)
bowser click e7                 # the click that opens it
bowser dialog-accept "Ann"      # a prompt gets "Ann"; with no text, its own default value
bowser click e8
```

```
### Modal state
- ["prompt" dialog with message "Your name?"]: accepted
```

The command that caused the dialog reports it under `### Modal state`. With `--json` it reports it as `"dialogs": [...]`. If the command fails, the report follows its error on stderr and the exit code is unchanged. `dismissed (run dialog-accept before the action to accept it)` means no answer was set. An answer covers one dialog and is dropped when the page navigates.

**Differences from `playwright-cli`:**

- In `playwright-cli`, the dialog stays open and `dialog-accept` answers it *after* the action. In bowser, `dialog-accept` after the action prepares the *next* dialog. It does not answer the one already reported.
- On WebKit, which has no dialog events, bowser replaces `window.alert`/`confirm`/`prompt` in the page before it acts there. A dialog the page opens while loading, before bowser's first command on that document, is dismissed by WebKit and not reported. A dialog whose handler then navigates the page (`if (confirm('Leave?')) location = …`) is answered but not reported, because the report leaves with the old page. A dialog opened through a reference the page saved at load time (`const c = window.confirm`) is dismissed by WebKit and not reported, and a prepared answer stays set until the next dialog bowser sees or a navigation. Chromium reports all of these. `beforeunload` is accepted on Chromium and not handled on WebKit.

### Snapshot output

`snapshot` prints the page's full accessibility tree in `playwright-cli`'s format: headings, text, state such as `[checked]` or `[active]`, `/url` and `/placeholder` props, and an `eN` ref on every visible element, not only the interactive ones. This is the todo fixture in `tests/fixtures/`:

````
### Page
- Page URL: http://localhost:52047/todo-app.html
- Page Title: Bowser Todo
### Snapshot
```yaml
- generic [active] [ref=e1]:
  - heading "Todos" [level=1] [ref=e2]
  - generic [ref=e3]:
    - textbox "New todo" [ref=e4]:
      - /placeholder: What needs doing?
    - button "Add" [ref=e5] [cursor=pointer]
  - list "Todo list" [ref=e6]:
    - listitem [ref=e7]: No todos yet
  - generic [ref=e8]:
    - generic [ref=e9]: 0 items left
    - button "Clear completed" [ref=e10] [cursor=pointer]
```
````

A ref stays the same across snapshots of one document while the element's role and name do not change; new elements get the next free number, so gaps are normal. After `fill e4 "buy milk"` and `click e5`, the list above becomes `listitem [ref=e11]` holding `checkbox "Toggle buy milk" [ref=e12]`, and `e5`, `e10` still name the same buttons. A navigation or reload starts again at `e1`.

Password field values are never shown: a filled `<input type="password">` prints as `textbox "Password" [ref=e3]` with no value, `state.json` does not store it, and it adds nothing to another element's name. This is a deliberate difference from `playwright-cli`, which prints the value.

An action on a ref whose element is gone (removed by a re-render, or from before a navigation or reload) fails at once with `ref 'eN' not found in the current page snapshot. Try capturing new snapshot.` and exit code 1, as in `playwright-cli`. Run `snapshot` again and use the new refs.

`--depth=N` prints N levels below the first line: a node at the limit drops its children but keeps its inline text value and its prop lines (`/url`, `/placeholder`). `--depth=0` or no flag prints the whole tree. Iframe contents and shadow DOM are not walked: an iframe prints as a leaf with a ref.

### JSON output for agent pipelines

`--json snapshot` prints `{"snapshot": "<tree>"}`: the tree text alone, without the `### Page` wrapper.

```bash
bowser --json snapshot | jq -r .snapshot | grep 'button'
```

## Command reference

| Command | Description |
| --- | --- |
| `install [--force]` | Download a headless Chromium |
| `open [url] [--persistent] [--profile=dir]` | Start session; navigate if URL given. `--persistent` keeps cookies, `localStorage` and IndexedDB in `~/.bowser/profiles/<session>/` across `close` and restarts; `--profile=dir` keeps them in `dir` instead (implies `--persistent`). See [Persistent profiles](#persistent-profiles). |
| `goto <url>` | Navigate within current session |
| `snapshot [--filename=f] [--depth=N]` | Full aria tree in `playwright-cli`'s format, with `eN` refs; `--depth=N` limits the levels printed (`0` or unset is unlimited) |
| `click <ref>` | Click an element |
| `fill <ref> <text>` / `fill <ref> --stdin` | Focus, clear, type. `--stdin` reads the text from piped input and drops one trailing newline, so a secret never appears in the process arguments: `op read op://vault/site/password \| bowser fill e4 --stdin`. The value is not echoed (`--json` answers `{"ok":true,"ref":"e4"}`). Not offered over MCP. |
| `type <text>` | Type into focused element |
| `press <key>` | Press a keyboard key |
| `hover <ref>` | Hover an element |
| `select <ref> <value>` | Choose a `<select>` option |
| `check <ref>` / `uncheck <ref>` | Toggle a checkbox |
| `dialog-accept [text]` / `dialog-dismiss` | Set the answer for the next `alert`/`confirm`/`prompt` (a prompt gets `text`, default its own value). Run it *before* the action; without one a dialog is dismissed. The action reports each dialog under `### Modal state`. |
| `screenshot [--filename=f]` | Full-page screenshot (PNG) |
| `resize <width> <height>` | Set the viewport size in pixels. Works on both backends. |
| `go-back` / `go-forward` / `reload` | Navigation |
| `list` | List sessions whose daemon answers. A session whose daemon is gone is not listed. |
| `close [name]` | End a session and remove its directory (defaults to `--session`; positional name overrides). Fails if the browser process cannot be confirmed stopped. |
| `close --all` | Close every open session |
| `localstorage-list` | List all `localStorage` entries (`key=value` per line, or JSON with `--json`) |
| `localstorage-get <key>` | Read a `localStorage` value |
| `localstorage-set <key> <value>` | Write a `localStorage` entry |
| `localstorage-delete <key>` | Remove a `localStorage` entry |
| `localstorage-clear` | Clear all `localStorage` entries |
| `sessionstorage-list` | List all `sessionStorage` entries (`key=value` per line, or JSON with `--json`) |
| `sessionstorage-get <key>` | Read a `sessionStorage` value |
| `sessionstorage-set <key> <value>` | Write a `sessionStorage` entry |
| `sessionstorage-delete <key>` | Remove a `sessionStorage` entry |
| `sessionstorage-clear` | Clear all `sessionStorage` entries |
| `eval <expression>` | Evaluate a JS expression in the current page; prints the result |
| `run-code <code>` | Run multi-statement JS in the current page; wrap in an IIFE, use `return` to produce a value |
| `cookie-list [--domain=<d>] [--url=<u>]` | List cookies for the current page (or specified scope). HttpOnly cookies are first-class. Requires the chrome backend. |
| `cookie-get <name> [--domain=<d>] [--url=<u>]` | Print a cookie's value (empty if not found). HttpOnly cookies are visible. Requires the chrome backend. |
| `cookie-set <name> <value> [--domain=<d>] [--url=<u>] [--path=<p>] [--http-only] [--secure] [--same-site=Strict\|Lax\|None] [--expires=<unix-s>]` | Set a cookie. Defaults URL to current page. `--http-only` sets the HttpOnly flag. Requires the chrome backend. |
| `cookie-delete <name> [--domain=<d>] [--url=<u>] [--path=<p>]` | Delete a cookie. Requires the chrome backend. |
| `cookie-clear` | Wipe all browser cookies in this session. Requires the chrome backend. |
| `state-save <file>` | Dump the cookie jar + current-origin localStorage to a Playwright-compatible `storageState` JSON file. Requires the chrome backend. |
| `state-load <file>` | Restore cookies + localStorage from a `storageState` file. localStorage restores for origins matching the current page; others are reported skipped. Requires the chrome backend. |
| `mcp` | Run a Model Context Protocol stdio server exposing every command above as an MCP tool. |

Global flags: `-s=<name>` / `--session=<name>`, `--json`, `-h/--help`.

## MCP bridge

`bowser mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, exposing every browser command as an MCP tool — so MCP clients (Claude Desktop, etc.) can drive the browser without shelling out. Each tool maps 1:1 to a CLI command and takes an optional `session` argument; outputs are the same JSON as `--json` mode.

Register it in an MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bowser": { "command": "bowser", "args": ["mcp"] }
  }
}
```

Notes:
- Run `bowser install` once first (it is intentionally **not** exposed as a tool — it shells out and downloads Chromium).
- The server is a thin client of the same per-session daemons the CLI uses; the first tool call on a fresh session spawns one.
- The protocol is hand-rolled (newline-delimited JSON-RPC) with zero runtime dependencies.

## How it works

1. `bowser open` spawns a per-session daemon holding a `Bun.WebView`, navigates, and saves `{url, title}` to `~/.bowser/sessions/<name>/state.json`.
2. `bowser snapshot` runs a [snapshot script](./src/page-scripts.ts) in the page that walks the DOM into an aria tree (roles, names, text, refs) and keeps a reference to each ref's element in the page; [`src/snapshot.ts`](./src/snapshot.ts) renders that tree as YAML. Refs are persisted with the CSS path each element had (`#id` when safe, otherwise an `nth-of-type` chain), e.g. `e3` → `html > body > button:nth-of-type(2)`.
3. `bowser click e3` resolves the ref from state, then in the page: the snapshot script kept a reference to each ref's element, so the command checks that element is still in the document and computes its CSS path afresh (a stale ref fails here, before anything is clicked). It then dispatches the click via the daemon, using `Bun.WebView`'s built-in actionability auto-wait — no polling, no hard-coded timeouts.

## Environment variables

| Variable | Effect |
| --- | --- |
| `BOWSER_BACKEND` | `webkit` or `chrome` — override the auto-selected browser backend. |
| `BOWSER_CHROMIUM_PATH` | Explicit path to a `chrome-headless-shell` binary; bypasses auto-detection. |
| `BOWSER_OP_TIMEOUT_MS` | Per-operation timeout in milliseconds (default `30000`; `0` disables). Bounds a wedged daemon operation — if the browser hangs, the command exits with a timeout error instead of blocking forever. |

## Tests

```bash
bun run typecheck                              # tsc
bun test                                       # unit + command tests with a fake daemon
BOWSER_E2E=1 bun test                          # + end-to-end on the resolved backend (WebKit on macOS, Chromium elsewhere)
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search)
```

**End-to-end examples included:**
- `tests/e2e.test.ts` — open/snapshot/click on a `data:` URL (no network)
- `tests/e2e-todo.test.ts` — a local todo app served by `Bun.serve`: add three todos, toggle one, clear completed. Proves the daemon keeps state across commands.
- `tests/e2e-webkit.test.ts` — every non-CDP command driven on WebKit, with page state read back via `eval` after each one.
- `tests/e2e-compat.test.ts` — diffs bowser against `playwright-cli` on the todo flow, asserting bowser's refs are a subset of playwright-cli's tree; skips without playwright-cli's WebKit installed.
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
- [x] Snapshot nesting honoring `--depth=N`
- [x] Full aria tree in `playwright-cli`'s snapshot format
- [ ] Storage commands (`cookie-*`, `localstorage-*`, `state-save`/`load`)
  - [x] `localstorage-{list,get,set,delete,clear}`
  - [x] `sessionstorage-{list,get,set,delete,clear}`
  - [x] `cookie-{list,get,set,delete,clear}` — HttpOnly cookies are first-class; uses `Bun.WebView.cdp()` (chrome backend only; see [design](./docs/superpowers/specs/2026-05-14-cdp-cookies-design.md))
  - [x] `state-save` / `state-load` — Playwright-compatible `storageState` JSON (cookies + per-origin localStorage; chrome backend only)
- [ ] Tab management (`tab-list`/`tab-new`/`tab-select`/`tab-close`) — deferred: `Bun.WebView` can't reach popups yet (`window.open` returns `null` on WebKit, and on Chromium the popup is not drivable), so tabs would leave out their main use; see the [refactor spec](./docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md#open-questions)
- [ ] Network mocking (`route`, `unroute`)
- [ ] Tracing / video / PDF output
- [x] `eval`, `run-code`
- [x] `resize`
- [x] `dialog-accept`/`dismiss` — the answer is set before the action; see [Dialogs](#dialogs)
- [x] MCP bridge subcommand for non-CLI clients (`bowser mcp`)
- [ ] Agent skill published to [agentskills.io](https://agentskills.io)

## Migrating from 0.1.0

The `0.2.0` release is a clean break: `snap → snapshot`, `@e3 → e3`, `--session → -s=`, `session list → list`. See [`CHANGELOG.md`](./CHANGELOG.md) for the full migration table.

## License

MIT
