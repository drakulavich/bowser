# Spec: `dialog-accept` / `dialog-dismiss`

**Status:** approved (backlog item 6). Revised 2026-09-26: the owner chose design A below after four
review rounds of the first design kept finding races.
**Origin:** README roadmap `- [ ] dialog-accept/dismiss`; the 2026-09-05 refactor spec names it the first
task after the refactor, with a caveat that WebKit has no dialog events.

## Measured (2026-09-26, page with `confirm('sure?')`, `prompt('name?','def')`, `alert('hi')`)

- `playwright-cli` 0.1.13: `click` returns in ~160 ms and prints
  `### Modal state` / `- ["confirm" dialog with message "sure?"]: can be handled by dialog-accept or dialog-dismiss`;
  `dialog-accept [text]` / `dialog-dismiss` then answer it (`prompt` gets the text).
- bowser on **Chromium** (main): `click` hangs until the op timeout (exit 2) and the session stays
  wedged — later commands hang, `eval` returns nothing. A bug.
- bowser on **WebKit** (main): the engine answers silently — `confirm` → `false`, `prompt` → `null`,
  `alert` closes. The agent never learns a dialog appeared and cannot accept one.

## Why design A

The first design kept a dialog *pending* on Chromium, as `playwright-cli` does: the command that
opened it returned early while its browser call stayed blocked. Every review round found a new race
around that orphaned call (serializer overlap, "reported failed but still ran", a second dialog lost,
a stale URL while blocked). All of them come from one thing: a dialog that stays open. Design A never
leaves one open, so none of that machinery exists.

## Behaviour

1. **No dialog ever stays open.** On both backends a dialog is answered the moment it opens:
   with the one-shot answer if one is set (then cleared), otherwise dismissed (`confirm` → false,
   `prompt` → null, `alert` closed). `beforeunload` is accepted, so navigation proceeds. The command
   that caused it therefore finishes normally, and no page command is ever blocked by a dialog.
2. **One-shot answer.** `dialog-accept [text]` (for a `prompt`: `text`, default the prompt's default
   value) and `dialog-dismiss` set the answer for the next dialog on the current page and print
   `next dialog will be accepted` / `next dialog will be dismissed`. They are ordinary queued ops,
   not urgent. A one-shot answer is dropped on navigation. Setting one replaces the previous one.
3. **Report.** Every dialog answered during a page command is recorded
   `{type, message, defaultValue?, state: "accepted" | "dismissed", answer?}` and reported by that
   command, then forgotten:
   ```
   ### Modal state
   - ["confirm" dialog with message "sure?"]: accepted
   - ["prompt" dialog with message "name?"]: dismissed (run dialog-accept before the action to accept it)
   ```
   (the hint only when dismissed for lack of a one-shot answer). `--json`: the command's object gains
   `"dialogs": [...]`, absent when none.
4. **Chromium.** The daemon subscribes to `Page.javascriptDialogOpening` **before the first
   navigation**, so a dialog during the very first page load is answered too, and handles each one
   at once with `Page.handleJavaScriptDialog`. The log lives in the daemon.
5. **WebKit.** A page-side shim replaces `window.alert/confirm/prompt`, answers synchronously the same
   way, and keeps the log and the one-shot answer in the page. It is (re)installed before each
   page-acting command runs, without an extra round trip where the command already evaluates in the
   page; dialogs raised before bowser first acts on a new document are answered by the engine
   (dismissed) and not reported. A dialog whose handler then navigates the page (`if (confirm(…))
   location = …`) is answered, but not reported: the log leaves with the old document. Reading the log costs at most one extra round trip per command, on
   WebKit only.
6. **Difference from `playwright-cli`** (documented in README, SKILL.md, CHANGELOG): the answer is set
   *before* the action. `dialog-accept` after an action does not answer the dialog that action
   opened; it prepares the next one.

## Acceptance (public seams only)

1. Unit (`fakeClient`): the report format, plain and `--json`, with and without the hint; `dialog-*`
   output; nothing appended when no dialog fired.
2. E2E on **Chromium and WebKit**, the same test file and the same expectations on both:
   - `click` on confirm without a one-shot answer returns in < 2 s, reports `dismissed` with the hint,
     the page shows `confirm:false`, and the next command works (the Chromium wedge regression);
   - `dialog-accept` then click confirm → `accepted`, page `confirm:true`;
   - `dialog-accept typed` then click prompt → `accepted`, page `prompt:typed`;
   - `dialog-dismiss` then click prompt → `dismissed` without the hint, page `prompt:null`;
   - alert is reported and the page continues;
   - the one-shot answer is used once (a second confirm click is dismissed);
   - a one-shot answer does not survive `goto`;
   - two dialogs from one click are both reported in order.
3. E2E on **Chromium only**: a page whose inline script calls `confirm()` during load does not hang
   `open`/`goto`, and the report or the next command shows it was dismissed.
4. Docs: README (roadmap box ticked, command rows, the "answer before the action" difference),
   SKILL.md (the flow), CHANGELOG, CLAUDE.md (a gotcha: dialogs are answered on open; never leave one
   pending).

## Out of scope

`playwright-cli`'s after-the-fact answering; file choosers; a default policy other than dismiss;
`beforeunload` on WebKit.
