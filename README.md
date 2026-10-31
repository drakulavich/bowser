# Bowser

[![test](https://github.com/drakulavich/bowser/actions/workflows/test.yml/badge.svg)](https://github.com/drakulavich/bowser/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@drakulavich/bowser-cli.svg)](https://www.npmjs.com/package/@drakulavich/bowser-cli)

bowser gives your AI agent a browser on your Mac: nothing to install beyond Bun, and snapshots never show a password's value.

```bash
npm install -g @drakulavich/bowser-cli   # macOS, Bun ≥ 1.4.4
bowser open https://example.com          # start a session and load the page
bowser snapshot                          # the page's accessibility tree, with refs
bowser click e3                          # click the element with ref e3
```

It drives the WebKit engine macOS already has, through [`Bun.WebView`](https://bun.com/docs/runtime/webview), so there is no browser to download. The commands, flags and snapshot format are those of Microsoft's [`playwright-cli`](https://github.com/microsoft/playwright-cli): replace `playwright` with `bowser` and the core loop of a playwright-cli skill (`open`, `snapshot`, `click`, `fill`, `press`) works unchanged. The differences: a dialog's answer is set before the action ([Dialogs](#dialogs)), there are no cookie or tab commands, and `run-code` runs in the page, not in Node. bowser runs on macOS only. For Chromium, Linux or Windows, use playwright-cli.

## Password values stay out of snapshots

A filled `<input type="password">` prints in a snapshot as `textbox "Password" [ref=e3]`, with no value, `state.json` does not store it, and it adds nothing to another element's name. `fill` and `type` never echo the text they entered, in any field. To keep a secret out of the process arguments as well, pipe it in with `fill --stdin`:

```bash
op read op://vault/app/password | bowser fill e4 --stdin   # prints: filled e4 (textbox "Password")
```

`playwright-cli` prints a password field's value in its snapshot. `eval` and `run-code` run whatever JavaScript the agent gives them, so they can still read a field's value.

## Read a page cheaply with `markdown`

`bowser markdown` prints the page as Markdown (headings, text, lists, tables, links and code) without the refs and roles a snapshot carries. Use it to read a page, and `snapshot` when the agent needs refs to act on. When the page publishes its own Markdown, through a `rel="alternate"` link or as a claude.ai artifact's source, you get that text. `bowser markdown e12` converts one element.

A prototype of the converter was measured on 7 pages in [#130](https://github.com/drakulavich/bowser/issues/130). On six of them its Markdown was 17% to 37% of the snapshot's size: Wikipedia's WebKit article went from 346 KB to 59 KB, and the Hacker News front page from 55 KB to 15 KB. A claude.ai artifact, which has little markup to strip, came out at 73%.

## Why

What sets it apart from `playwright-cli`:

- **No browser to download.** It uses the WebKit macOS already has.
- **Password values stay out of snapshots.** See [above](#password-values-stay-out-of-snapshots).
- **`markdown` reads a page for a fraction of a snapshot's size.** See [above](#read-a-page-cheaply-with-markdown).
- **Fewer tokens than playwright-cli.** In the [agent benchmark](docs/benchmark.md) (10 browser tasks, 3 runs each, Claude Sonnet 5.5, 2026-10-21), an agent used 413k tokens and $0.41 with bowser against 445k and $0.51 with playwright-cli, summed over the per-task medians. Both passed all 30 runs.

## Install

```bash
# From npm
npm install -g @drakulavich/bowser-cli

# ...or directly from source
git clone https://github.com/drakulavich/bowser.git
cd bowser
bun install
bun link                     # exposes `bowser` on $PATH
```

The npm package runs on the `bun` it finds on your `PATH`. [docs/install.md](https://github.com/drakulavich/bowser/blob/main/docs/install.md) covers the Bun version check, moving off a release binary, and what happens to open sessions and `bowser mcp` on an upgrade.

### Claude Code plugin

This repo is also a Claude Code plugin marketplace. The plugin installs the `bowser` skill and registers `bowser mcp` as an MCP server:

```bash
claude plugin marketplace add drakulavich/bowser
claude plugin install bowser@bowser
```

Inside a session, `/plugin install bowser --marketplace drakulavich/bowser` does both. The plugin does not contain the CLI: install it from npm first. Without `bowser` on the `PATH`, the skill's commands fail with `command not found` and `/mcp` shows `plugin:bowser:bowser` as failed (`Executable not found in $PATH`). `claude plugin update bowser@bowser` picks up a new release.

## Quickstart

```bash
bowser open https://example.com          # start a session and load the page
bowser snapshot                          # refs for the page's elements
bowser fill e5 "hello@bowser.dev"        # fill the field whose ref the snapshot gave as e5
bowser press Enter                       # submit
bowser screenshot --filename=shot.png    # capture
bowser close                             # end session
```

Each session runs one persistent browser process (spawned lazily on first command, addressed over a Unix socket). Commands attach, run, and detach — so typed text, modals, dynamic DOM, cookies, and auth all survive across invocations. Session state lives under `~/.bowser/sessions/<name>/`. Several commands started at once on a new session still share one browser.

If the page's web process crashes, WebKit relaunches it and reloads the page once. That reload looks like the page reloading itself, so bowser does not report it: page state is gone, and old refs fail with `not found in the current page snapshot`. If the process dies again, WebKit does not reload the page, and every page command fails with `the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'` (exit 2). bowser does not reload it for you; `reload`, `goto` or `open <url>` recover it.

If a session's browser exits (it crashed, or was killed), every command but `open` and `close` fails with `session '<name>' is not open (its browser exited); run 'bowser open'` (exit 1). [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#a-session-whose-browser-exited).

### Multiple sessions

```bash
bowser -s=login open https://app.example.com/login
bowser -s=login fill  e1 "me@example.com"
op read op://vault/app/password | bowser -s=login fill e2 --stdin
bowser -s=login click e3
```

Commands on one session run one at a time: when several clients (parallel shell calls, two MCP servers) send commands to the same session, each waits its turn and runs whole.

### Persistent profiles

A session's browser store is in memory by default: `close` (or a crash) loses its logins. A persistent profile is the way to keep cookies, and so logins, between sessions: bowser has no cookie commands, and `state-save`/`state-load` carry only `localStorage`. Open the session with `--persistent` to keep cookies, `localStorage` and IndexedDB on disk, like `playwright-cli open --persistent`:

```bash
bowser -s=app open https://app.example.com/login --persistent   # profile in ~/.bowser/profiles/app/
bowser -s=app close                                              # the profile stays
bowser -s=app open https://app.example.com --persistent         # still logged in
bowser -s=work open https://app.example.com --profile=./profiles/work   # a directory of your choice
```

- The profile lives outside `~/.bowser/sessions/<name>/`, so `close` leaves it alone. Delete it with `rm -rf ~/.bowser/profiles/<name>` (or your `--profile` directory).
- The store is chosen when the session's browser starts. `open --persistent` on a session that is already running with another store fails with exit 1; run `bowser close` first. `open` without the flag reuses a running persistent session.
- One profile directory serves one running session at a time; sharing it between two is unsupported.
- A persistent store needs macOS 15.2 or later.

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

The command that caused the dialog reports it under `### Modal state`. In `playwright-cli` the dialog stays open and `dialog-accept` answers it *after* the action; in bowser, `dialog-accept` after the action prepares the *next* dialog. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#dialogs): `--json`, iframes, page-defined dialog functions, and the dialogs bowser cannot see.

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

An action on a ref whose element a re-render removed fails at once with `ref 'eN' not found in the current page snapshot. Try capturing new snapshot.` and exit code 1, as in `playwright-cli`. A ref from another page (from before a navigation or reload, or from the page you left before `go-back`) fails the same way with `ref 'eN' is from a page that is no longer loaded; take a new snapshot`. Run `snapshot` again and use the new refs. A `pushState` or `#hash` change keeps the page, and its refs keep working.

An action on a ref whose element changed its role or name since the snapshot (a `Buy A` button that relabelled itself) also fails, exit code 1, before it touches the page: `ref 'e2' now points to button "Delete account", not button "Buy A"; take a new snapshot`. `click` and `fill` on a ref whose centre another element covers (a backdrop, or a `+` button the page put where `Add` was) fail the same way and name what covers it: `ref 'e2' (button "Add to cart") is covered by generic <div> at its click point; take a new snapshot or close what covers it`. A `playwright-cli` frame ref such as `f1e3` fails with `'f1e3' is a playwright-cli frame ref; bowser does not snapshot iframe contents`.

`--depth=N` prints N levels below the first line: a node at the limit drops its children but keeps its inline text value and its prop lines (`/url`, `/placeholder`). `--depth=0` or no flag prints the whole tree. Iframe contents and shadow DOM are not walked: an iframe prints as a leaf with a ref.

### JSON output for agent pipelines

`--json snapshot` prints `{"snapshot": "<tree>"}`: the tree text alone, without the `### Page` wrapper. `snapshot --filename=f` writes the `### Page` text to `f`, with or without `--json`, and answers `wrote /…/f` (`{"ok":true,"filename":"/…/f"}` under `--json`, with `"dialogs"` when a dialog was answered).

```bash
bowser --json snapshot | jq -r .snapshot | grep 'button'
```

### Screenshots

Screenshots are written as PNG files, or JPEG when `--filename` ends in `.jpg` or `.jpeg` (quality 80). A capture is the viewport, as in `playwright-cli` without `--full-page`; use `resize` to capture more. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#screenshot): file names, pixel size and `--scale`, the 4 GiB limit, and the wait for web fonts.

## Command reference

| Command | Description |
| --- | --- |
| `open [url] [--persistent] [--profile=dir]` | Start session; navigate if URL given. `--persistent` keeps cookies, `localStorage` and IndexedDB in `~/.bowser/profiles/<session>/` across `close` and restarts; `--profile=dir` keeps them in `dir` instead (implies `--persistent`). See [Persistent profiles](#persistent-profiles). |
| `goto <url>` | Navigate within current session. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#goto). |
| `snapshot [--filename=f] [--depth=N]` | Full aria tree in `playwright-cli`'s format, with `eN` refs; `--depth=N` limits the levels printed (`0` or unset is unlimited) |
| `markdown [ref] [--filename=f] [--link-text]` | The page as Markdown, for reading. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#markdown). |
| `click <ref>` | Click an element. A disabled element (the snapshot's `[disabled]`: a disabled control or `<fieldset>`, or `aria-disabled="true"` on it or an ancestor) fails at once with `ref 'eN' is disabled`, exit 1, and is not clicked; `playwright-cli` waits out its timeout |
| `fill <ref> <text>` / `fill <ref> --stdin` | Focus, clear, type. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#fill). |
| `type <text>` | Type into focused element. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#type). |
| `press <key>` | Press a keyboard key, or a combination as in `playwright-cli`: `Shift+Tab`, `Meta+a`, `Shift+Meta+ArrowRight`. [More](https://github.com/drakulavich/bowser/blob/main/docs/commands.md#press). |
| `hover <ref>` | Send the pointer's entry events (`pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove`, `mousemove`) at the element's centre. CSS `:hover` never applies: Bun.WebView has no native pointer move. When the page does not change within 200 ms, the reply says `hovered eN; the page did not change within 200 ms (bowser cannot trigger CSS :hover)`, exit 0; `--json` adds `"changed":true\|false` |
| `select <ref> <value>` | Choose a `<select>` option: the first, in document order, whose value or label is `<value>` (`select e3 Red` picks `<option value="r">Red</option>`). With no such option it fails at once with `ref 'eN' has no option "<value>"` (exit 1) and the select keeps its value; `playwright-cli` waits out its timeout |
| `check <ref>` / `uncheck <ref>` | Check or uncheck a checkbox or radio button. A disabled one fails like `click`. `uncheck` on a checked radio fails with `ref 'eN' is a radio button; select another option in its group to uncheck it`, exit 1; on an unchecked one it succeeds and does nothing. An `aria-checked="mixed"` checkbox is unchecked for `check` (one click, as in `playwright-cli`) and checked for `uncheck`, which clicks it until it reads `false` (`playwright-cli` leaves it mixed) |
| `dialog-accept [text]` / `dialog-dismiss` | Set the answer for the next `alert`/`confirm`/`prompt` (a prompt gets `text`, default its own value). Run it *before* the action; without one a dialog is dismissed. The action reports each dialog under `### Modal state`. |
| `screenshot [--filename=f] [--scale=N]` | Screenshot of the viewport (PNG, or JPEG for a `.jpg`/`.jpeg` `--filename`); no full-page capture. Waits up to 5 s for the page's own web fonts (not its iframes'); `; fonts still loading` when they did not arrive |
| `resize <width> <height>` | Set the viewport size in pixels, each side 1 to 16384 (`Bun.WebView`'s limit) |
| `go-back` / `go-forward` / `reload` | Navigation |
| `wait-for --url <part>` / `wait-for --text <text>` | Wait until the page URL (`location.href`) or its visible text (`document.body.innerText`) contains the value: a client-side route change or text that arrives after a `click` has answered. Prints the URL and saves it to the session. Bounded by the command's budget; when it runs out it fails with `wait-for: no URL containing '<part>' after <ms>ms; the page is at <url>` (exit 2). One of the two flags, not empty. `playwright-cli` has no such command; Playwright MCP's `browser_wait_for` is the closest. |
| `list` | List sessions whose daemon is running. One whose daemon runs but does not answer (stopped, or its socket removed) is marked `<name> (not answering; run 'bowser close -s <name>')`. A session whose daemon is gone is not listed. `--json` gives `[{"name":"…","answering":true\|false}]` |
| `close [name]` | End a session and remove its directory (defaults to `--session`; positional name overrides). Fails if the browser process cannot be confirmed stopped, including a daemon from bowser 0.5 or older that does not answer: it wrote no pidfile, so `close` exits 2 and keeps the session until you end the process yourself (the error says how). A name with no session answers `session '<name>' is not open` (exit 0), as `playwright-cli` does, so a typo in `-s` does not look like a close. |
| `close --all` | Close every open session; a directory a refused start left behind is removed but not listed. If one cannot be closed, it still tries the rest, then fails (exit 2) naming each such session with its reason and listing the ones it closed |
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
| `run-code <code>` | Run JavaScript in the current page and print the result. One expression is evaluated as one (`run-code "(() => { return 5 })()"` prints `5`); any other code is the body of an async function, so use `return` for the result, and `await` works (`run-code "await new Promise(r => setTimeout(r, 100)); return document.title"`). Unlike `playwright-cli`'s `run-code`, which calls a function with a Playwright `page` in Node, it runs in the page: a result that is a function, such as `async page => …`, fails with `run-code runs JavaScript in the page and has no Playwright 'page'; write statements and use return` (exit 1) |
| `state-save <file>` | Save the current origin's localStorage to a Playwright-compatible `storageState` JSON file. Its `cookies` array is always empty: bowser has no cookie access (use `open --persistent` to keep logins). A page with no origin (`about:blank`) saves no origins. |
| `state-load <file>` | Restore localStorage from a `storageState` file. It restores origins matching the current page and reports the others skipped. Cookies in the file are skipped, with one line on stderr. A missing, invalid or wrongly shaped file (`storageState.origins: expected array, got object`) restores nothing and exits 1. |
| `mcp` | Run a Model Context Protocol stdio server exposing every command above as an MCP tool. |

With `--json`, and so over MCP, `click`, `fill`, `hover`, `select`, `check` and `uncheck` name the element the ref pointed to, with the role and name its snapshot gave: `click e724` answers `{"ok":true,"ref":"e724","element":{"role":"button","name":"Add to cart"},"url":"…"}`.

Global flags: `-s=<name>` / `--session=<name>`, `--json`, `-h/--help`, `--version` (prints the version and runs nothing). A session name uses letters, digits, `.`, `_` and `-`, and does not start with `.` or `-`. It is at most 255 characters, or fewer under a very long `HOME`: `<HOME>/.bowser/sessions/<name>/pid.<pid>.tmp` must fit Bun's 1016-character path limit. A longer name is a usage error that gives the limit.

`bowser <command> --help` (or `-h` anywhere before `--`) prints that command's usage, arguments and flags and runs nothing; `bowser mcp --help` does not start the server. After `--`, `--help` is text like any other argument.

A command given more arguments than it takes fails before it runs, with `usage: too many arguments for '<cmd>': expected <n>, received <m>` and exit code 1. Quote an argument that has spaces: `bowser eval "1 + 1"`, `bowser fill e4 "hello world"`. Words after `--` count too, so `fill e1 -- a b` is too many. `bowser mcp` with any extra word fails the same way and does not start the server.

A command given fewer arguments than it requires fails the same way, with its usage line: `bowser select e3` fails with `usage: bowser select <ref> <value>` and exit code 1. An empty argument is a value, as in `playwright-cli`: `bowser select e3 ""` selects the option whose value is empty, and `bowser localstorage-set k ""` stores an empty string.

## MCP bridge

`bowser mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, exposing every browser command as an MCP tool — so MCP clients (Claude Desktop, etc.) can drive the browser without shelling out. Each tool maps 1:1 to a CLI command and takes an optional `session` argument; outputs are the same JSON as `--json` mode.

Arguments are checked against the tool's input schema. A wrong type (`session: 42`, an object where a string belongs, `persistent: "false"`) or a key the tool does not have is refused with an `isError` result starting `usage:`, and nothing runs. Where the schema says string, a finite number is also taken (`resize {width: 800, height: 600}`), and `null` is the same as leaving the argument out.

Register it in an MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bowser": { "command": "bowser", "args": ["mcp"] }
  }
}
```

Notes:
- The server is a thin client of the same per-session daemons the CLI uses; the first tool call on a fresh session spawns one.
- Relative file paths (`screenshot`, `snapshot` `filename`, `state-save`, `state-load`) resolve against the server's working directory. If the client starts it from `/` or another directory it cannot write, the server uses `<os.tmpdir()>/bowser-mcp` instead (`$TMPDIR/bowser-mcp`). Replies name the absolute path written. An absolute path is used as given.
- The protocol is hand-rolled (newline-delimited JSON-RPC) with zero runtime dependencies. It speaks MCP `2025-11-25`, `2025-06-18` and `2024-11-05`: `initialize` answers with the client's version when it is one of these, and with `2025-11-25` otherwise. The stateless `2026-07-28` revision is not implemented; its `server/discover` probe gets `-32601 Method not found`, on which a client falls back to `initialize`.
- `initialize`, `ping`, `tools/list` and notifications are answered at once, even while tool calls run. During a handover the server answers `ping` itself until the installed bowser is up, so a `ping` does not wait for the calls the server finishes first.
- A JSON-RPC batch (an array) or a line that is not a JSON object gets one `-32600 Invalid Request` error with `id: null`; nothing in a batch runs. MCP `2025-06-18` has no batching.
- A request without a string `method` gets `-32600 Invalid Request` with its `id`, and a `tools/call` of a tool the server does not have gets `-32602 Unknown tool`. A response from the client (a message with `result` or `error`) gets no answer.
- Tool calls for different sessions run concurrently; calls for the same session run one at a time, in the order they arrived. Responses may therefore arrive out of order (JSON-RPC matches them by `id`).
- The server exits when stdin closes and every running call has answered. A client that stops reading stdout is gone: the server exits 0 at its next response, and calls still queued never run. A browser operation already running finishes in its daemon.
- `notifications/cancelled` drops the call: one still queued behind its session never runs, and a running one finishes but its result is discarded. Either way no response is sent for it, per the MCP spec. A browser operation that has already started is **not** undone — a cancelled `click` may still have clicked, and the session's next call waits for it to finish.

## How it works

1. `bowser open` spawns a per-session daemon holding a `Bun.WebView`, navigates, and saves `{url, title}` to `~/.bowser/sessions/<name>/state.json`.
2. `bowser snapshot` runs a [snapshot script](./src/page-scripts.ts) in the page that walks the DOM into an aria tree (roles, names, text, refs) and keeps a reference to each ref's element in the page; [`src/snapshot.ts`](./src/snapshot.ts) renders that tree as YAML. Refs are persisted with the CSS path each element had (`#id` when safe, otherwise an `nth-of-type` chain), e.g. `e3` → `html > body > button:nth-of-type(2)`.
3. `bowser click e3` resolves the ref from state, then in the page: the snapshot script kept a reference to each ref's element, so the command checks that element is still in the document and computes its CSS path afresh (a stale ref fails here, before anything is clicked). It then waits in the page itself: synchronous polls until the element holds the same box for two frames in a row and its centre hits it, then a native click at that point. A navigation during the wait ends it with `click: the page navigated before the click; nothing was clicked, run 'bowser snapshot' to see the new page` (exit 2).

bowser's scripts run in the page's own JavaScript world, and WebKit returns their results through the page's `JSON.stringify`. bowser sets aside the builtin patches that legacy libraries such as Prototype.js install, and it refuses a page that replaced `JSON.stringify`. It does not defend against a page written to deceive automation: such a page can forge any check made from inside it.

## Environment variables

| Variable | Effect |
| --- | --- |
| `BOWSER_OP_TIMEOUT_MS` | Per-command timeout in milliseconds (default `30000`; `0` disables). See [Timeouts](#timeouts). |
| `BOWSER_DAEMON_DEBUG` | `1` writes the output of a session daemon that this command starts to `~/.bowser/sessions/<session>/daemon.log`, for debugging a daemon that fails to start. `close` deletes it with the session directory. |

### Timeouts

`BOWSER_OP_TIMEOUT_MS`: Per-command timeout in milliseconds (default `30000`; `0` disables). It covers the whole command: each step of a command gets the time the command has left, and time spent queued behind another command counts, so a wedged browser makes a command exit with a timeout error instead of blocking forever. The daemon reads it once, when the session starts, and a value set on a later command applies to that command only when it is smaller. To raise it, `close` the session and `open` it again with the new value. An upgrade restart keeps it (see [Upgrading](https://github.com/drakulavich/bowser/blob/main/docs/install.md#upgrading)).

- A timeout names the command and, when it differs, the step that overran: `'fill' timed out after 3000ms (in its 'click' step)` (exit 2).
- When the time runs out after an action was sent, the timeout says the action may have reached the page: `'click' timed out after 3000ms; the click may have been delivered, check the page before retrying`. Once the action has returned it says `the click was delivered`, and `waiting for the page it opened` when the action started a navigation that has not loaded yet. Retrying without checking may act twice.
- If a timed-out command is still running 2 s later (or after the budget, if shorter), the daemon reloads the page once to free the browser (in a session that has not loaded a page yet, where a reload does nothing, it leaves the blank page instead).
- A command whose client goes away (killed, or its terminal closed) gets 5 s more to finish once its connection closes (or what is left of its budget, if less), and is then ended the same way, with or without a budget.
- If the command outlives that reload, every other command fails at once with `session is stuck: '<cmd>' is still running after a reload; run 'bowser close'` (exit 2) until it ends; `close` always works. A command sent during the 2 s and the reload waits for them, so the first such failure can take up to 12 s after the timeout (up to 22 s in a session that has not loaded a page yet, where leaving the blank page can take two 10 s tries).
- An action such as `click` or `fill` on a page still loading a navigation that an earlier command started waits for it, and fails with `page is still loading <url>; retry later, or run 'bowser close'` (exit 2) if the time runs out first.
- If the daemon itself stops answering mid-command (frozen or swapped out), the command gives up 2 s after its budget with `daemon for session '<s>' did not answer; run 'bowser close -s <s>' to stop it` (exit 2), and `bowser close -s <s>` ends it.

## Tests

```bash
bun run check                                  # typecheck, lint, then unit tests
bun run typecheck                              # bun check
bun run lint                                   # bun fmt --check, Biome (import cycles, layer rules) and Knip (unused files, exports)
bun test                                       # unit + command tests with a fake daemon
BOWSER_E2E=1 bun test                          # + end-to-end on WebKit
BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test         # + live-internet e2e (GitHub search)
```

There are 38 end-to-end test files, `tests/e2e.test.ts` and `tests/e2e-*.test.ts`; for example:

- `tests/e2e.test.ts` — screenshots and >8 KB snapshots and URLs on `data:` pages (no network)
- `tests/e2e-snapshot.test.ts` — a local todo app served by `Bun.serve`: fill, click Add and check, each tree compared to `playwright-cli`'s golden.
- `tests/e2e-webkit.test.ts` — every command driven on WebKit, with page state read back via `eval` after each one.
- `tests/e2e-compat.test.ts` — diffs bowser against `playwright-cli` on the todo flow, asserting bowser's refs are a subset of playwright-cli's tree; skips without playwright-cli's WebKit installed.
- `tests/e2e-search.test.ts` — live web: search GitHub for OpenClaw, find the repo link, type into the search box and press Enter.

## Roadmap

- [x] Persistent session daemon over Unix socket
- [x] playwright-cli command compatibility for the core agent loop
- [x] Snapshot nesting honoring `--depth=N`
- [x] Full aria tree in `playwright-cli`'s snapshot format
- [x] Storage commands (`localstorage-*`, `sessionstorage-*`, `state-save`/`load`)
  - [x] `localstorage-{list,get,set,delete,clear}`
  - [x] `sessionstorage-{list,get,set,delete,clear}`
  - [x] `state-save` / `state-load` — Playwright-compatible `storageState` JSON (per-origin localStorage; no cookies, use `open --persistent`)
- [ ] Tab management (`tab-list`/`tab-new`/`tab-select`/`tab-close`) — deferred: `Bun.WebView` can't reach popups yet (`window.open` returns `null` on WebKit), so tabs would leave out their main use; see the [refactor spec](./docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md#open-questions)
- [ ] Network mocking (`route`, `unroute`)
- [ ] Tracing / video / PDF output
- [x] `markdown`: the page, or one element, as Markdown
- [x] `eval`, `run-code`
- [x] `resize`
- [x] `dialog-accept`/`dismiss` — the answer is set before the action; see [Dialogs](#dialogs)
- [x] MCP bridge subcommand for non-CLI clients (`bowser mcp`)
- [ ] Agent skill: follows the [agentskills.io](https://agentskills.io/specification) spec and ships as a Claude Code plugin from this repo's marketplace ([Claude Code plugin](#claude-code-plugin)); a listing in Anthropic's plugin directory is still open

## License

MIT
