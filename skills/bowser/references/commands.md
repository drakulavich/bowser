# Command details

The full notes behind the command table in `SKILL.md`.

| Command | Details |
| --- | --- |
| `bowser open [url] [--persistent] [--profile=dir]` | Start session; navigate if URL given. `--persistent` keeps cookies/localStorage/IndexedDB in `~/.bowser/profiles/<session>/` across `close`; `--profile=dir` uses `dir` (implies `--persistent`). `close` keeps the profile; `rm -rf` it to delete. One running session per profile. |
| `bowser goto <url>` | Navigate within current session. `open` and `goto` add a missing scheme: `http://` for `localhost`, `127.0.0.1`, `[::1]` (`localhost:3000/x`), `https://` otherwise (`example.com`); a URL with a scheme is used as typed. Both wait for `load`, at most 5 s after the page is parsed; then they answer with the page as it is, and the next command that acts or navigates stops the loads still running |
| `bowser wait-for --url <part>` / `--text <text>` | Wait until `location.href` or the page's visible text contains the value; prints the URL and saves it. Bounded by the budget: `wait-for: no text "<text>" after <ms>ms; the page is at <url>` (exit 2) |
| `bowser snapshot [--filename=f] [--depth=N]` | Full aria tree with `eN` refs; `--depth=N` limits the levels printed (`0` or unset is unlimited); `--filename` writes the `### Page` text to `f` and answers with its absolute path |
| `bowser markdown [ref] [--filename=f] [--link-text]` | The page as Markdown, for reading: the page's own Markdown when it has some (a claude.ai artifact, `rel="alternate" type="text/markdown"` with no relative links), else `<main>` or the body converted. On a YouTube video with captions, its transcript in `[m:ss]` paragraphs. A ref converts only that element. `--link-text` prints converted links as their text without URLs (images keep theirs). `--json` adds `"source":"page"\|"converted"\|"transcript"` |
| `bowser click <ref>` | Click an element by ref. A `[disabled]` one fails at once with exit 1 and is not clicked |
| `bowser fill <ref> <text>` / `fill <ref> --stdin` | Focus, clear, type into a field. `--stdin` takes the text from piped input, minus one trailing newline, so a secret stays out of the process arguments: `op read op://vault/site/password \| bowser fill e4 --stdin`. The text is never echoed back, plain or `--json` (`{"ok":true,"ref":"e4","element":{"role":"textbox","name":"Password"}}`), with or without `--stdin`. Refuses a disabled or readonly field (exit 1). Sets `date`/`time`/`datetime-local`/`month`/`week`/`color` inputs directly (`fill e9 2024-01-02`); a value they do not keep, or text on `type=number`, fails with exit 1. A newline becomes a space in an `<input>` and stays in a `<textarea>` |
| `bowser type <text>` | Type into focused element. Prints `typed N characters` (`typed 1 character` for one), never the text; `--json` gives `{"ok":true,"length":N}` |
| `bowser press <key>` | Press a keyboard key or a combination: `Tab` moves focus to the next field, `Shift+Tab` back; `Meta+a` selects all (macOS keys: `Control+a` goes to the line start). Modifiers: `Shift`, `Control`, `Alt`, `Meta`, `ControlOrMeta`. No `F1`–`F12`, lone modifiers or key codes (`KeyA`): those fail with `usage:`. `Meta+c/x/v` do not reach the clipboard |
| `bowser hover <ref>` | Wait, as `click` does, for the element to be visible, still and on top at its centre; then send the pointer's entry events (`pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove`, `mousemove`) at the element's centre. CSS `:hover` never applies: Bun.WebView has no native pointer move. When the page does not change within 200 ms, the reply says `hovered eN; the page did not change within 200 ms (bowser cannot trigger CSS :hover)`, exit 0; `--json` adds `"changed":true\|false` |
| `bowser select <ref> <value>` | Wait for the `<select>` to be visible, then choose an option by value or label (the first match in document order); no match fails with exit 1 and changes nothing, and so does a `[disabled]` select |
| `bowser check <ref>` / `uncheck <ref>` | Wait for a checkbox/radio to be visible, then check or uncheck it. A `[disabled]` one fails (exit 1); `uncheck` on a checked radio fails (exit 1): select another option in its group. `aria-checked="mixed"` counts as unchecked for `check`, checked for `uncheck` |
| `bowser screenshot [--filename=f] [--scale=N]` | Screenshot of the viewport (PNG, or JPEG for a `.jpg`/`.jpeg` `--filename`); no full-page capture. Waits up to 5 s for the web fonts the page itself asked for (not its iframes'); `; fonts still loading` in the reply means they did not arrive and the text may be missing or in a fallback font |
| `bowser resize <width> <height>` | Set the viewport size in pixels, each side 1 to 16384 |
| `bowser list` | Sessions whose daemon is running, one per line. A daemon that runs but does not answer is marked `<name> (not answering; run 'bowser close -s <name>')`. `--json` gives `[{"name":"…","answering":true\|false}]` |
| `bowser close [name]` | End a session and remove its data (defaults to `--session`; positional name overrides). Ends a daemon of another bowser version too. Exits 2 and keeps the session when it cannot confirm the browser stopped. A name with no session answers `session '<name>' is not open`, exit 0 |
| `bowser close --all` | Close every open session; if one fails, the rest are still closed and it exits 2 naming each failure with its reason |
| `bowser localstorage-list` / `sessionstorage-list` | List entries (`key=value` lines, or JSON) |
| `bowser run-code <code>` | Run JavaScript **in the page** (not Playwright code, unlike `playwright-cli`'s). One expression is evaluated as one (`"(() => { return 5 })()"` prints `5`); other code is an async function body: `return` the result, `await` works. A function result such as `async page => …` fails (exit 1) |
| `bowser state-save <file>` | Save localStorage to a Playwright `storageState` JSON file (`cookies` is always empty) |
| `bowser state-load <file>` | Restore localStorage from a `storageState` file; cookies in it are skipped. A bad file names the wrong field and exits 1 |

Under `--json` and over MCP, the ref commands (`click`, `fill`, `hover`, `select`, `check`, `uncheck`) add `"element":{"role":"…","name":"…"}`, the role and name the snapshot gave the ref. Compare it with the element you meant before acting on the result.

Session names (`-s=<name>`): letters, digits, `.`, `_`, `-`, at most 255 characters, fewer under a very long `HOME`.

`bowser <command> --help` prints that command's usage and flags without running it, so it is safe on
`close` or `open`. After `--`, `--help` is plain text: `bowser fill e1 -- --help` types it.

An extra word fails the command with `usage: too many arguments for '<cmd>': expected <n>, received <m>` (exit 1),
words after `--` included. A missing argument fails with the command's usage line
(`usage: bowser select <ref> <value>`, exit 1); an empty one (`""`) is a value.

## Snapshot details

- State shows as `[checked]`, `[disabled]`, `[expanded]`, `[active]` (focused), `[selected]`, `[level=N]`; links carry `- /url:`, textboxes `- /placeholder:`.
- Any visible element can have a ref, not only controls. Refs stay the same across snapshots of one document while the element's role and name are unchanged, so gaps in the numbers are normal. A navigation or reload starts again at `e1`.
- Password field values are never shown: a filled `<input type="password">` prints without its value, unlike `playwright-cli`.
- `--depth=N` prints N levels below the first line: a node at the limit drops its children but keeps its inline text value and its prop lines (`/url`, `/placeholder`). `--depth=0` or no flag prints the whole tree. `--json` gives `{"snapshot": "<tree>"}` without the `### Page` header.
- Refs persist in `~/.bowser/sessions/<name>/state.json`. The CLI resolves refs for you.

## Storage and logins

- `state-save <file>` dumps the current origin's localStorage; `state-load <file>` restores it. The JSON is interchangeable with Playwright's `storageState`. Because the daemon holds one page, load only restores localStorage for origins matching the current page (others are reported skipped): navigate to an origin first, then `state-load`. sessionStorage is not persisted (matching Playwright).
- bowser has no cookie commands, and `state-save` writes an empty `cookies` array (`state-load` skips any cookies, with one line on stderr). To keep a login between sessions, open the session with `--persistent` (or `--profile=<dir>`) each time; if it is already running without it, `bowser close` first.
- Commands on one session run one at a time, so parallel calls on the same session wait their turn instead of mixing their steps.

## Screenshots

Screenshots are written as PNG files, or JPEG (quality 80) when `--filename` ends in `.jpg` or `.jpeg`, in any case; any other extension, or none, exits 1 without writing. Use `--filename` to set the output path, or the default `screenshot-<session>.png` (auto-increments if the file exists). The reply names the absolute path written, as `snapshot --filename`'s does, and the image's size in pixels (`wrote /…/out.png (1600×1200)`, `{"ok":true,"filename":"/…/out.png","width":1600,"height":1200}`). The size follows the display's pixel ratio; `--scale=N` fixes it at `innerWidth·N × innerHeight·N` by scaling the capture down, and exits 1 without writing when N is above the display's ratio. A capture is the viewport only, like `playwright-cli` without `--full-page`; there is no full-page or element capture. `resize` first to capture more. WebKit cannot capture a viewport whose pixels fill 4 GiB (at pixel ratio 2, `resize 16384 16384` is too large and `16384 16383` fits); `screenshot` then exits 1 and names the size to resize to.

## MCP

`bowser mcp` runs a Model Context Protocol stdio server exposing every command as an MCP tool. It resolves relative paths against its working directory, or against `$TMPDIR/bowser-mcp` when started from `/` or an unwritable directory. Use the absolute path in the reply.
