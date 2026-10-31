# Command details

The [command reference](https://github.com/drakulavich/bowser/blob/main/README.md#command-reference) in the README gives one line per command. These commands have more to say.

## goto

`goto <url>`

Navigate within current session. For `open` and `goto` alike, a URL without a scheme gets one, as in `playwright-cli`: `http://` for `localhost`, `127.0.0.1` and `[::1]` (`localhost:3000/x` → `http://localhost:3000/x`), `https://` for any other host (`example.com` → `https://example.com`). A URL with a scheme (`http:`, `file:`, `about:`, `data:`, …) is used as typed. Unlike `playwright-cli`, `127.0.0.1` gets `http://`, not `https://`. Both wait for the page's `load` event. When the page has been parsed but `load` has not come 5 s later (an image, font or script that never finishes), they answer with the page as it is. The next command that acts on the page or leaves it stops the loads still running first; what had not loaded by then stays missing.

## markdown

`markdown [ref] [--filename=f] [--link-text]`

The page as Markdown, for reading. When the page offers its own Markdown (a claude.ai artifact's source, or `<link rel="alternate" type="text/markdown">`), that text, unless an alternate's links start with `/`, `./` or `../`, which gives the conversion below instead; otherwise `<main>` (or the body without one) converted: headings, paragraphs, lists, tables, links, code, emphasis, image `alt`, a checkbox in a list item as `[x] ` or `[ ] `, with hidden content and other form controls left out. On a YouTube video with captions (`/watch?v=`, `/shorts/`, `youtu.be`), the transcript instead: the title, `https://youtu.be/<id> · <language>`, then one paragraph per 30 seconds starting `[m:ss]`; it opens the description and the transcript panel to read it, and exits 2 with `markdown: the transcript of <url> did not load within <n>ms` when the panel gives nothing in time. With a ref, only that element is converted, without scrolling the page. `--link-text` prints each converted link as its text alone, without the URL, which halves a link-heavy page; images keep their URLs, and the page's own Markdown and a transcript are printed unchanged. `--json` gives `{"markdown":"…","source":"page"|"converted"|"transcript","url":"…","title":"…"}`; an empty result prints `markdown: the page has no text ("<title>", <url>)`; `--filename` writes the Markdown to `f` and answers with its absolute path, after the no-text line when the page has none; its `--json` adds `url` and `title`

## fill

`fill <ref> <text>` / `fill <ref> --stdin`

Focus, clear, type. `--stdin` reads the text from piped input and drops one trailing newline, so a secret never appears in the process arguments: `op read op://vault/site/password | bowser fill e4 --stdin`. The text is never echoed, with or without `--stdin`: `filled e4 (textbox "Password")`, and `--json` answers `{"ok":true,"ref":"e4","element":{"role":"textbox","name":"Password"}}`. `--stdin` is not offered over MCP. A disabled (a disabled `<fieldset>` included) or `readonly` field fails with `ref 'eN' is not an editable element (disabled)` or `(readonly)`, exit 1, value untouched; `playwright-cli` waits out its timeout. A `date`, `time`, `datetime-local`, `month`, `week` or `color` input gets the value set directly, as `playwright-cli` does (`fill e9 2024-01-02`); one it does not keep fails with `ref 'eN' did not accept the value for input[type=<type>]`. On `type=number`, text that is not a number fails with `ref 'eN' needs a number (input[type=number])`. Both exit 1 and leave the value as it was; no error repeats the text. A one-line `<input>` turns a newline in the text into a space (`a\nb` becomes `a b`), as typing into it would; a `<textarea>` keeps the newline; in a contenteditable editor a newline is an Enter press, as with `type`.

## type

`type <text>`

Type into focused element. The text is never echoed: it prints `typed N characters` (`typed 1 character` for one), counting code points, and `--json` answers `{"ok":true,"length":N}`. In a contenteditable editor a newline in the text (`\n` or `\r\n`) is an Enter press, as in Playwright: Lexical and ProseMirror start a new paragraph, and a chat box that sends on Enter sends at the first newline. For several lines in such a chat, `type` each line and `press Shift+Enter` between them. If Enter moves focus out of the editor, `type` stops and fails with `type: focus left the editor after line N of M; the rest was not typed`. An `<input>` gets a space and a `<textarea>` a newline, with no Enter key event, so no form is submitted. For `fill` and `type` alike, a browser error that quotes the text is replaced by `<command>: the browser's error message was withheld because it contained the entered text`; a dialog message the page shows is page content and is printed as is

## press

`press <key>`

Press a keyboard key, or a combination as in `playwright-cli`: `Shift+Tab`, `Meta+a`, `Shift+Meta+ArrowRight`. Modifiers are `Shift`, `Control`, `Alt`, `Meta` and `ControlOrMeta` (which is `Meta`: bowser runs on macOS). `Tab` moves focus to the next field, as the browser's own Tab does, and types nothing; `Shift+Tab` moves it back. The key is one character or `Enter`, `Tab`, `Space`, `Backspace`, `Delete`, `Escape`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`. Known differences from `playwright-cli`: WebKit through `Bun.WebView` cannot press `F1`–`F12`, a modifier alone (`Shift`) or a key code (`KeyA`, `NumpadEnter`), so these fail with `usage:` (exit 1); `Meta+c`, `Meta+x` and `Meta+v` reach the page as keydowns but do not copy, cut or paste. Keys follow macOS: `Control+a` moves to the start of the line, `Meta+a` selects all, `Meta+z` undoes

## A session whose browser exited

If a session's browser exits (it crashed, or was killed), every command but `open` and `close` fails with `session '<name>' is not open (its browser exited); run 'bowser open'` (exit 1), or gives the recorded `bowser open --persistent` / `bowser open --profile=<dir>` command when session state records a profile; paths are quoted when needed. State from an older bowser has no profile record, so bowser falls back to checking the default profile directory. This avoids quietly starting an empty browser. `bowser open` (with the same profile option again, when one was recorded) starts it anew; `bowser close` clears it. A session that never ran a browser still starts one on its first command.

## Dialogs

The command that caused the dialog reports it under `### Modal state`. With `--json` it reports it as `"dialogs": [...]`. A report lists the first 20 dialogs and then `- and N more dialogs` (`"dialogsOmitted": N` with `--json`), so a page timer that opens a dialog every 100 ms does not flood the next command. If the command fails, the report follows its error on stderr and the exit code is unchanged. `dismissed (run dialog-accept before the action to accept it)` means no answer was set. An answer covers one dialog and is dropped when the page navigates.

**Differences from `playwright-cli`:**

- In `playwright-cli`, the dialog stays open and `dialog-accept` answers it *after* the action. In bowser, `dialog-accept` after the action prepares the *next* dialog. It does not answer the one already reported.
- WebKit has no dialog events, so bowser replaces `window.alert`/`confirm`/`prompt` in the page, and in every same-origin iframe it can reach, before it acts there. A dialog in such an iframe is reported like the page's own and takes the prepared answer. A dialog that fires between commands (a timer) is reported by the next command that prints dialogs, even when that command leaves the page (`reload`, `goto`, `open`, `go-back`, `press Enter` on a form).
- A function the page defined itself (`window.confirm = m => …`) is left alone and runs, as in `playwright-cli`; its calls are not dialogs and are not reported.
- A page function made with `.bind()` from the browser's own (`window.confirm = confirm.bind(window)`) looks native to bowser: the shim replaces it, and the dialog is reported.
- Not reported, and dismissed by WebKit:
  - a dialog the page opens while loading, before bowser's first command on that document;
  - a dialog in a cross-origin iframe, or in an iframe that loaded after bowser's last command;
  - a dialog opened through a reference the page saved at load time (`const c = window.confirm`), including a page wrapper around it (`window.confirm = m => c(m)`).

  In each of these cases a prepared answer stays set until the next dialog bowser sees or a navigation.
- A dialog whose handler then navigates the page (`if (confirm('Leave?')) location = …`) is answered but not reported, because the report leaves with the old page.
- `beforeunload` is not handled.

## screenshot

Screenshots are written as PNG files, or JPEG when `--filename` ends in `.jpg` or `.jpeg` (quality 80); any other extension, or none, fails with exit code 1. `bowser screenshot --filename out.png` writes to `out.png` (relative paths resolve against your current directory); without `--filename` it writes `screenshot-<session>.png`, auto-incrementing (`-1`, `-2`, …) if that file already exists. The reply names the absolute path written and the image's size in pixels (`wrote /…/out.png (1600×1200)`, `{"ok":true,"filename":"/…/out.png","width":1600,"height":1200}`); `snapshot --filename` names the path too. The size follows the display's pixel ratio: an 800×600 viewport is 1600×1200 on a Retina display and 800×600 on one at ratio 1. `--scale=N` fixes it at `innerWidth·N × innerHeight·N` by scaling the capture down, or fails with exit code 1 when N is above the display's ratio, since bowser cannot render more pixels than the display has. A capture is the viewport, as in `playwright-cli` without `--full-page`: bowser has no full-page or element-bounded screenshots (`Bun.WebView` captures only the viewport). Use `resize` to capture more. WebKit cannot capture a viewport whose pixels fill 4 GiB. On a Retina display (pixel ratio 2) that is reached only near `resize`'s maximum: `resize 16384 16384` cannot be captured, `resize 16384 16383` can. `screenshot` then fails with exit code 1 and names the size to resize to. Before it captures, `screenshot` waits up to 5 s for the web fonts the page itself has asked for (not those of its iframes), such as a font first used by text a script added after the page loaded. If they are still loading after 5 s it captures anyway and adds `; fonts still loading` to the reply (`"fontsLoading":true` under `--json`): the image may show text in a fallback font or none at all, so retry, or check that the font URL answers.
