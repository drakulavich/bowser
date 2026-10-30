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
