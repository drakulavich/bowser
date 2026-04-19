# Bowser

A Bun-native, token-efficient browser automation CLI for AI agents. Bowser fuels your agent with web context — clean, structured, and tiny in the context window.

Built on [`Bun.WebView`](https://bun.com/docs/runtime/webview) (new in Bun 1.3.12), so on macOS there's nothing to install beyond Bun itself, and on Linux / Windows it drives any installed Chrome / Chromium / Edge over the DevTools Protocol.

## Why

Most browser tools for agents fall into two camps:

- **MCP servers** (like [`@playwright/mcp`](https://playwright.dev)) — load 20+ tool schemas and an accessibility tree into the model's context on every turn. Expensive.
- **Screenshot-driven loops** — require a vision model and still lose structured page information.

Bowser takes the third path popularized by [Playwright's CLI](https://playwright.dev/agent-cli/introduction) and [Vercel's `agent-browser`](https://github.com/vercel-labs/agent-browser):

- **Ref-based snapshots.** `bowser snap` writes a YAML list of interactive elements tagged `@e1`, `@e2`, … to disk. The agent reads only what it needs.
- **No tool schemas.** Capabilities are shell commands. A skill description of a few hundred tokens covers the whole API.
- **Bun-native.** Single static binary via `bun build --compile`. Fast cold start. No Node / npm / Playwright install dance.

## Install

```bash
# From source for now
git clone https://github.com/drakulavich/bowser.git
cd bowser
bun install
bun link                     # exposes `bowser` on $PATH
```

Requires Bun ≥ 1.3.12. On Linux/Windows, install a Chromium-based browser (`chromium-headless-shell`, Chrome, Edge, or Brave). macOS uses system WebKit — nothing extra needed.

## Quickstart

```bash
bowser open https://example.com          # navigate, save state
bowser snap -i                           # print @e1, @e2 refs
bowser click @e3                         # click a ref
bowser fill @e5 "hello@bowser.dev"       # fill a form field
bowser session show                      # inspect current session
bowser close                             # clear state
```

Each session runs one persistent browser process (spawned lazily on first command, addressed over a Unix socket). Commands attach, run, and detach — so typed text, modals, dynamic DOM, cookies, and auth all survive across invocations. Session state lives under `~/.bowser/sessions/<name>/`.

### Multiple sessions

```bash
bowser --session login  open https://app.example.com/login
bowser --session login  fill @e1 "me@example.com"
bowser --session login  fill @e2 "$PASSWORD"
bowser --session login  click @e3
```

### JSON output for agent pipelines

```bash
bowser --json snap | jq '.refs[] | select(.role == "button")'
```

## Command reference

| Command | Description |
| --- | --- |
| `open <url>` | Navigate to a URL and persist state |
| `snap [-i]` | Capture interactive elements with stable CSS paths |
| `click <@ref>` | Click a ref from the last snapshot |
| `fill <@ref> <text>` | Focus, clear, and type into a form field |
| `close` | Clear the current session's state |
| `session [list\|show]` | Inspect sessions |

Global flags: `--session <name>`, `--json`, `-h/--help`.

## How it works

1. `bowser open` launches `Bun.WebView`, navigates, saves `{url, title}` to `~/.bowser/sessions/default/state.json`, and exits.
2. `bowser snap` re-opens a WebView, re-navigates to the saved URL, runs a [snapshot script](./src/snapshot.ts) in the page that walks the DOM, picks interactive elements, computes a stable CSS path (`#id` when safe, otherwise an `nth-of-type` chain), and returns a list of refs. The refs are persisted so later commands can resolve `@e3` → `html > body > button:nth-of-type(2)` without another snapshot.
3. `bowser click @e3` resolves the ref from state and calls `view.click(selector)`, which uses `Bun.WebView`'s built-in actionability auto-wait — no polling, no timeouts hard-coded by us.

Because selectors are stable paths (not injected `data-` attributes), they survive the reload between commands.

## Tests

```bash
bun test                                       # unit + command tests with a fake daemon
BOWSER_E2E=1 bun test                          # + end-to-end against real headless Chromium
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search)
```

**End-to-end examples included:**
- `tests/e2e.test.ts` — open/snap/click on a `data:` URL (no network)
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
- [ ] `screenshot`, `eval`, `press`, `scroll`, `wait-for` CLI commands (ops exist in daemon)
- [ ] `extract --schema schema.json` for structured extraction without LLM round-trip
- [ ] Cookie / auth-profile management (`Bun.WebView` `dataStore`)
- [ ] MCP bridge subcommand for non-CLI clients
- [ ] Agent skill published to [agentskills.io](https://agentskills.io)

## License

MIT
