# Spec: `dialog-accept` / `dialog-dismiss`

**Status:** approved (backlog item 6; owner decision 2026-09-26 on the WebKit model).
**Origin:** README roadmap `- [ ] dialog-accept/dismiss`; the 2026-09-05 refactor spec names it the first
task after the refactor and prepared `DaemonState.dialog`, `Browser.subscribe()` and the urgent lane
for it, with a caveat that WebKit has no dialog events.

## Measured today (2026-09-26, page with `confirm('sure?')`, `prompt('name?','def')`, `alert('hi')`)

- `playwright-cli` 0.1.13: `click` returns in ~160 ms and prints
  `### Modal state` / `- ["confirm" dialog with message "sure?"]: can be handled by dialog-accept or dialog-dismiss`;
  `dialog-accept [text]` / `dialog-dismiss` then answer it (`prompt` gets the text).
- bowser on **Chromium**: `click` hangs until the op timeout (exit 2) and the session stays wedged —
  later commands hang, `eval` returns nothing. A bug.
- bowser on **WebKit**: the engine answers silently — `confirm` → `false`, `prompt` → `null`, `alert`
  closes. The agent never learns a dialog appeared and cannot accept one.

## Behaviour

### Commands

- `dialog-accept [text]`: accept; for a `prompt`, answer `text` (default: the prompt's default value).
- `dialog-dismiss`: dismiss (`confirm` → false, `prompt` → null).
- Each answers **the pending dialog** if one is open (Chromium only, see below); otherwise it sets a
  **one-shot answer for the next dialog** on that page (both backends) and says so:
  `next dialog will be accepted` / `… dismissed`. A one-shot answer is lost on navigation.

### Chromium

1. The daemon subscribes to `Page.javascriptDialogOpening`. When a dialog opens and a one-shot answer
   is set, the daemon answers it at once (`Page.handleJavaScriptDialog`) and records it as handled.
   Otherwise the dialog becomes **pending** (`DaemonState.dialog`).
2. The command that caused it (any page-acting command: `click`, `press`, `fill`, `check`, `select`,
   `hover`, `eval`, `run-code`, …) returns within ~1 s instead of waiting for the page, and its output
   carries the modal state (below). Exit 0.
3. While a dialog is pending, every page command except `dialog-*`, `close`, `list` fails at once with
   exit 1: `a <type> dialog is open ("<message>"); run dialog-accept or dialog-dismiss`.
4. `dialog-accept`/`dialog-dismiss` run on the urgent lane, answer it, clear it; the page continues.
   The session is never wedged by a dialog.

### WebKit

5. A page-side shim replaces `window.alert/confirm/prompt`. It answers synchronously from the one-shot
   answer if set (then clears it), else dismisses (today's result), and appends
   `{type, message, defaultValue, answer}` to a per-document log. It is (re)installed before each
   page-acting command runs, without an extra daemon round trip where the command already evaluates
   in the page; dialogs raised by page code before bowser first acts on a new document are not seen.
6. After a page-acting command, the log is read and cleared, and every recorded dialog is reported
   (below). Reading it costs at most one extra round trip per command, only on WebKit.

### Output

- Pending (Chromium), appended to the command's plain answer:
  ```
  ### Modal state
  - ["confirm" dialog with message "sure?"]: can be handled by dialog-accept or dialog-dismiss
  ```
- Handled already (one-shot answer, or WebKit's shim):
  ```
  ### Modal state
  - ["confirm" dialog with message "sure?"]: accepted
  - ["prompt" dialog with message "name?"]: dismissed (run dialog-accept before the action to accept it)
  ```
  (the hint only when it was dismissed for lack of a one-shot answer).
- `--json`: the command's object gains `"dialogs": [{ "type", "message", "defaultValue"?, "state":
  "pending" | "accepted" | "dismissed", "answer"? }]`, absent when none.
- `snapshot` while a dialog is pending (Chromium) prints the `### Modal state` section after
  `### Page` and no tree, as `playwright-cli` does not render a tree under a modal.

## Acceptance (public seams only)

1. Unit (`fakeClient`): output format for pending and handled dialogs, plain and `--json`; the
   "dialog is open" user error and exit-1 classification; `dialog-*` with and without a pending dialog.
2. E2E on **Chromium**: for confirm, prompt (with text), alert — `click` returns < 2 s with the pending
   modal state; `dialog-accept`/`dismiss` answers it and the page shows the result; a page command in
   between fails with the user error; the regression "after a dialog the session still works" (the
   bug above). One-shot answer before the click is applied without a pending state.
3. E2E on **WebKit**: without a one-shot answer, the click reports `dismissed` with the hint and the page
   shows `confirm:false`; with `dialog-accept typed` before a prompt click, the page shows
   `prompt:typed` and the report says `accepted`; `dialog-dismiss` before a confirm; alert reported.
4. Docs: README (roadmap box ticked, command rows, the WebKit order difference), SKILL.md (both flows),
   CHANGELOG, CLAUDE.md (the pending/urgent-lane mechanism and the shim).

## Out of scope

Dialogs raised during page load before bowser acts; `beforeunload` on WebKit; file choosers; a
default policy other than dismiss.
