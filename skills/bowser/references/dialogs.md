# Dialogs in detail

The answer covers one dialog and is dropped when the page navigates. The action that opened the dialog reports it:

```
### Modal state
- ["confirm" dialog with message "Delete it?"]: accepted
```

`dismissed (run dialog-accept before the action to accept it)` means no answer was set. To accept it, run `dialog-accept` and repeat the action. Running `dialog-accept` *after* the action does not answer the dialog that action opened, unlike `playwright-cli`. It prepares the next one.

A dialog in a same-origin iframe is reported like the page's own and takes your prepared answer. A dialog a timer opens between commands is reported by the next command that prints dialogs, even one that leaves the page (`reload`, `goto`, `go-back`, `press Enter` on a form). A report lists the first 20 dialogs and then `- and N more dialogs`; with `--json`, `dialogs` holds the first 20 and `dialogsOmitted` the count of the rest. If the page defines its own `window.confirm` (an in-page modal, a test stub), bowser leaves it alone: it runs, and nothing is reported. A function the page made with `.bind()` from the browser's own (`confirm.bind(window)`) looks native to bowser: it is replaced, and the dialog is reported.

These are dismissed and not reported, and your prepared answer stays set for the next dialog:

- a dialog the page opens while it loads, before bowser has acted on it;
- a dialog in a cross-origin iframe, or in an iframe that loaded after your last command;
- a dialog opened through a reference the page saved while loading (`const c = window.confirm`), including a page wrapper that calls it (`window.confirm = m => c(m)`).

A dialog whose handler then leaves the page (`if (confirm(…)) location = …`) is answered but not reported. Check where the page went instead.
