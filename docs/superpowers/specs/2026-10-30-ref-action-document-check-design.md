# Each ref action checks the document it acts on (#111)

Issue: #111. It follows the #105 spec (`2026-10-02-refs-document-identity-design.md`). Probes and the options weighed: [comment on #111](https://github.com/drakulavich/bowser/issues/111#issuecomment-6520014060).
Status: draft, waiting for review.

## Goal

A ref command acts only on the document its snapshot came from, also when the page navigates after `resolve` answered and before the action runs. On any other document the action does nothing and the command fails with the #105 message, exit 1:

```
ref 'e2' is from a page that is no longer loaded; take a new snapshot
```

Today `resolve` checks the saved `doc` (`src/page-scripts.ts:1316`) and returns a CSS path, and the action request carries only that path (`src/commands/interaction.ts:35`, `95`, `179`, `188`, `198`, `207`). A document that commits between the two requests gets the action.

## Design

Every ref action request carries the saved `doc`. A page-script action compares it with the store's `doc` in the same evaluate that finds the element. A native action (`click`, and `type` when `fill` sends it) runs the same comparison right before the native call.

### Protocol

The ref action ops take `doc` (`src/daemon/protocol.ts:56-65`) and may answer `Gone`, which is `{ gone: true }`:

| op | args | result |
| --- | --- | --- |
| `click` | `[selector, doc?, timeoutMs?]` | `void \| Gone` |
| `type` | `[text, doc?]` | `void \| Gone` |
| `hover` | `[selector, doc?]` | `void \| Gone` |
| `select` | `[selector, value, doc?]` | `boolean \| Gone` |
| `check` | `[selector, doc?]` | `void \| Gone` |
| `uncheck` | `[selector, doc?]` | `boolean \| Gone` |

The daemon writes `click`'s timeout into `args[2]` (`server.ts:553`), and the handler maps the wire order to the method: `click: (browser, selector, doc, timeoutMs) => browser.click(selector, timeoutMs, doc)` (`server.ts:348`). Spreading the args straight into `browser.click` would pass `doc` as the timeout and bring back the #112 hang. Without `doc` an op behaves as today. An older daemon is restarted by `connect` (`OlderDaemon`, `src/commands/context.ts:80`), so the client never meets one.

### Page side

One fragment, `docMatches(doc)`, evaluates `window[Symbol.for('bowser.aria-refs')]?.doc === <doc>`.

- `hoverScript`, `selectScript` and `setCheckedScript` take `doc` and return `{ gone: true }` before `querySelector` when it does not match. The `Browser` methods and the `check` handler pass that object through before their own conversions (`browser.ts:839-846`, `server.ts:353-355`); otherwise a refused `select` reads as `has no option` and a refused `uncheck` as success.
- `fillScript` takes `doc` and returns `{ outcome: 'gone' }`. `FillOutcome` (`page-scripts.ts:920`) and `FILL_OUTCOMES` (`interaction.ts:75`) gain `gone`.

### Native side

`Browser.click(selector, timeoutMs, doc?)` and `Browser.type(text, doc?)` evaluate `docMatches(doc)` as the first step of the function they pass to `nav.act`, after `NAV_ARM` (`browser.ts:597`). If the answer is not `true`, they return `GONE` without calling `view.click` or `view.type`. An evaluate that throws propagates as today. `type`'s line-by-line path (#243) checks once, before the first line.

### Command side

A helper in `context.ts` throws the #105 `UserError` when an action answers `{ gone: true }`; the text is one constant shared with `liveSelector`. `cmdClick`, `cmdHover`, `cmdSelect`, `cmdCheck` and `cmdUncheck` pass `doc` and call it. `cmdFill` passes `doc` to `click`, `fillScript` and `type`, and maps `outcome: 'gone'` to the same error. `cmdType` and `cmdPress` take no ref and do not change.

## Out of scope

- #267: `click` hangs when the document is replaced during Bun's actionability wait.
- The gap between the daemon's check and `view.click` or `view.type`. Bun.WebView has no hook to close it.

## Definition of done

1. `tests/e2e-ref-window.test.ts` serves A and B with the same markup (a checkbox, a `<select>`, a button with hover and click handlers, at the same CSS paths). After `snapshot` on A, a `ctx.connect` wrapper sends `navigate` to B after the `resolve` reply. `check`, `uncheck` (box starts checked), `select`, `hover` and `click` each fail with the message, and B is unchanged. On main each acts on B.
2. `fill`, with the navigation after `resolve`, after `click` and (contenteditable) after `fillScript`, fails with the message each time and leaves B's field empty. On main B's field holds the text.
3. `tests/browser.test.ts`: with a doc check that answers `false`, `click` and `type` return `{ gone: true }` and the fake view records no `click` or `type`; `hover`, `select` and `setChecked` pass a `{ gone: true }` evaluate answer through. `tests/daemon-handler.test.ts`: a `click` request `["#a", "<doc>"]` reaches `browser.click` as `("#a", <time left>, "<doc>")`.
4. `tests/commands.test.ts`: each ref command sends its saved `doc`, and a `{ gone: true }` answer gives the message. `tests/exit-codes.test.ts`: that case exits 1.
5. `type` and `press` send no `doc`; the existing tests, the #105, #91, #112 and ET-10 e2e tests and the MCP tests pass unchanged.
6. Items 1 to 4 fail with the check line removed; one red line each in the PR body.
7. `bun run check` passes, and `BOWSER_E2E=1 bun test` passes in CI.
8. CHANGELOG `[Unreleased]` has a `Fixed` entry naming #111, and the PR closes #111.
