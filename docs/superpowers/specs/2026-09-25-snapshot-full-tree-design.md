# Spec: `snapshot` prints the full accessibility tree, in playwright-cli's format

**Status:** approved (backlog item 2, 2026-09-25 priority list).
**Origin:** the maintainability refactor spec (2026-09-05, "Findings") froze bowser's snapshot
format and named "full aria tree in playwright-cli 0.1.x format" the first backlog item after
the series, because it affects every agent turn. The format below was captured from
`playwright-cli` 0.1.13 on 2026-09-25 (Microsoft Edge 153, playwright-core 1.61.0-alpha) against
`tests/fixtures/todo-app.html` and `tests/fixtures/kitchen-sink.html`. The capture notes and raw
outputs are in the implementation branch's research directory; the parts that bind are restated
here.

## Problem

`bowser snapshot` prints only interactive elements under landmark ancestors. An agent cannot
read page text ("0 items left", headings, paragraphs), checkbox and option state, or placeholders
from a snapshot. It needs extra `eval` calls, and prompts written for `playwright-cli` do not
transfer. The line syntax also differs (`button "Add": [ref=e2]` against
`button "Add" [ref=e5]`), so bowser is not a drop-in replacement where it matters most.

## Behaviour

### 1. Output wrapper (`snapshot` without `--json`)

```
### Page
- Page URL: <location.href>
- Page Title: <document.title>
### Snapshot
```yaml
<tree>
```
```

- No blank lines anywhere. The command's output ends right after the closing fence; the CLI
  adds the single trailing newline, as it does today.
- `- Page Title:` is omitted when the title is empty. URL and title are printed raw (no
  quoting or escaping).
- playwright-cli's `- Console: …` line is **not** printed: bowser does not capture console
  messages. `### Events`, `### Modal state` and the other sections are out of scope.
- `--filename=<f>` writes exactly the text that would be printed and prints `wrote <f>`, as today.

### 2. `--json`

`snapshot --json` prints `JSON.stringify({ snapshot: <tree> }, null, 2)`. The `url`, `title`
and `refs` keys of today's JSON go away (breaking; see CHANGELOG below).

### 3. The tree

The tree is built inside the page from `document.body` by bowser's own walker in
`src/page-scripts.ts`. It does **not** read the browser's accessibility tree, so the output is
the same on the webkit and chrome backends except where layout differs (visibility, `cursor`,
display). The grammar is playwright-cli's; the list below is binding.

**3.1 Lines and indentation.** Each node is one line: two spaces per depth level, `- `, the
key, then either nothing (leaf), `: <value>` (one inline text child, no props), or `:` followed
by its props and children one level deeper. The tree text has no trailing newline.

**3.2 Key.** `<role>[ "<name>"][ attrs…]`, the name JSON-encoded (`JSON.stringify`) and omitted
when empty. Attributes, each preceded by one space, in exactly this order:

| # | attribute | when |
| --- | --- | --- |
| 1 | `[checked]` / `[checked=mixed]` | checkbox, radio, switch, option, menuitemcheckbox, menuitemradio, treeitem; checked true / mixed (`indeterminate` or `aria-checked="mixed"`). Unchecked prints nothing. |
| 2 | `[disabled]` | disabled element or `aria-disabled="true"`, on roles that support it (button, checkbox, combobox, link, listbox, menuitem*, option, radio, slider, spinbutton, switch, tab, textbox, treeitem, and group/radiogroup/toolbar/menu containers) |
| 3 | `[expanded]` | `aria-expanded="true"`, or an open `<details>`'s `<summary>`; false prints nothing |
| 4 | `[active]` | the node is `document.activeElement` (when nothing is focused, that is `<body>`) |
| 5 | `[level=N]` | headings (`h1`–`h6` → 1–6, or `aria-level`) |
| 6 | `[pressed]` / `[pressed=mixed]` | `aria-pressed` true / mixed |
| 7 | `[selected]` | option (`selected`), tab/row/cell/treeitem with `aria-selected="true"` |
| 8 | `[ref=eN]` | see 3.6 |
| 9 | `[cursor=pointer]` | the node has a ref, its computed `cursor` is `pointer`, and no ancestor node printed `[cursor=pointer]` |

If the whole key needs YAML quoting (3.5), the line is `- '<key>'`, with inner `'` doubled.

**3.3 Props and children.** Props come first, one level deeper, as `- /<prop>: <value>`:
`/url` for links with an `href` (the attribute value, as written), then `/placeholder` for
textboxes whose `placeholder` differs from their name. Children follow in DOM order: nodes, or
text lines `- text: <value>`. A link with an `href` is always in block form because of its
`/url` prop. The inline form `- <key>: <value>` is used only when the node has exactly one
child, it is text, and there are no props.

**3.4 Which elements become nodes, and their text.**
- Every element that is rendered becomes a node with its ARIA role: explicit `role` if valid,
  otherwise the implicit HTML role (html-aam), otherwise `generic`. `role="presentation"` /
  `"none"` elements are skipped and their children lifted. Elements that are `display:none`,
  `visibility:hidden`, `aria-hidden="true"` (with their subtree), `<script>`, `<style>`,
  `<template>`, `<head>` are not nodes.
- Implicit roles, at least: `a[href]` link; `button`, `input[type=button|submit|reset|image]`
  button; `input` text-like and `textarea` textbox; `input[type=checkbox]` checkbox;
  `input[type=radio]` radio; `input[type=range]` slider; `input[type=number]` spinbutton;
  `input[type=search]` searchbox; `select` combobox (listbox when `multiple` or `size>1`);
  `option` option; `h1`–`h6` heading; `p` paragraph; `ul`/`ol` list; `li` listitem; `nav`
  navigation; `main` main; `header` banner and `footer` contentinfo when not inside
  article/aside/main/nav/section; `aside` complementary; `article` article; `section` region
  only when it has an accessible name, otherwise generic; `form` form only when named,
  otherwise generic; `img[alt]` img (`alt=""` is presentation); `table` table; `thead`/`tbody`/
  `tfoot` rowgroup; `tr` row; `th` columnheader; `td` cell; `details` group; `dialog` dialog;
  `hr` separator; `label` not associated with a control → generic.
- `<summary>` renders as `generic` with its text as name (the observed Edge output,
  `generic "More"`).
- **Text.** Text nodes are collected in DOM order and whitespace-normalized; runs of text between
  element children merge into one `- text:` line. An element whose computed `display` is
  `inline`, whose role would be `generic`, and whose only child is one text node is not a node:
  its text flows into the parent's text run. This holds even when the element is focusable or
  has a click handler (`<span tabindex="0">`), as in Playwright; such a span has no ref. A node whose only text child
  equals its name drops that text.
- **Form values.** For `input` (not checkbox/radio/file/hidden) and `textarea`, the only child is
  the current `value`, whitespace-normalized; an empty value gives no child. Text inside them is
  ignored. A `select` has its `option` children (each `[selected]` if selected); its value is
  not a text child.
- **Generic collapse.** Bottom-up, a `generic` node with no name whose children (after collapse)
  are at most one node, and that node has a ref, is replaced by that child. This is why a page
  whose body has one child starts at that child (`- main [ref=e2]:`).
- **Accessible name**, in order: `aria-labelledby` (the referenced elements' text, joined by a
  space), `aria-label`, for form controls the associated `<label>`s (`for=` or wrapping; the
  label's text minus the control's own text), `alt` for images, then for roles that take their
  name from content (button, cell, checkbox, columnheader, heading, link, menuitem*, option,
  radio, row, rowheader, switch, tab, treeitem, tooltip) the element's text content, then
  `title`, then for textboxes `placeholder`. Whitespace-normalized; names over 900 characters
  are dropped (printed with no name).
- Iframes, shadow DOM and `aria-owns` are **out of scope**: an `<iframe>` prints as
  `iframe [ref=eN]` with no children, shadow roots are not entered, and `aria-owns` is ignored.

**3.5 YAML quoting.** A string needs quoting if it is empty; has leading or trailing whitespace;
contains a control character, `\n` or `\r`; starts with `-`; contains `:` or `\n` followed by
whitespace or at the end; contains whitespace followed by `#`; starts with one of
`` & * ] , ? ! > | @ " ' # % ``; contains `{`, `}` or `` ` ``; starts with `[`; parses as a
number; or equals, ignoring case, one of `y n yes no true false on off null`.
- Keys that need quoting are wrapped in single quotes (3.2).
- Values (inline text, `- text:` and prop values) that need quoting are double-quoted, escaping
  `\\ \" \b \f \n \r \t` and other control characters as `\xNN`; otherwise they are printed bare.

**3.6 Refs.**
- A node gets a ref when its box is visible (non-zero width and height, `visibility` not hidden)
  and it can receive pointer events (`pointer-events` is not `none`). A `display: contents`
  element has no box of its own and counts as visible when any child is, as in Playwright.
  Text lines never have refs.
- Refs are `e` + a per-document counter, assigned in DOM pre-order during the walk, including to
  nodes that are later collapsed or cut by `--depth`; gaps in the printed numbers are expected.
- **Refs are sticky**: the ref is remembered per element for the life of the document and reused
  on the next snapshot while the element's role and name are unchanged; otherwise the element
  gets the next number. A new document (navigation, reload) starts again at `e1`.
- Every ref-bearing node is saved to the session state as today (`id`, `selector`, `role`,
  `name`, `tag`, and `href` / `value` where present), with `selector` computed by the existing
  `cssPath`. The action commands keep resolving refs through that selector. The `path` field of
  `Ref` is removed.

### 4. `--depth=N`

Depth 0 is the first printed line. With `--depth=N` (N ≥ 1), nodes deeper than N are not printed,
and a node at depth exactly N prints without its children but keeps its inline text value and
its prop lines (`/url`, `/placeholder`). `--depth=0` and no flag mean unlimited. Non-integers and negatives are a
usage error (`usage: --depth=N …`, exit 1). Collapse happens before depth is applied.

### 5. Actions refuse a ref of the wrong kind

Refs now land on non-interactive nodes too, so an action must not report success on an element
it cannot act on. Before sending anything to the daemon (no extra round trip, no side effect),
the command checks the ref saved by the last snapshot:

| command | accepted | otherwise, exit 1 with |
| --- | --- | --- |
| `check`, `uncheck` | role `checkbox`, `radio`, `switch`, `menuitemcheckbox`, `menuitemradio` | `ref 'eN' is not a checkbox or radio button (<role>)` |
| `select` | tag `select` | `ref 'eN' is not a <select> element (<role>)` |
| `fill` | role `textbox`, `searchbox`, `spinbutton`, `combobox` with tag `input`, or a `contenteditable` element | `ref 'eN' is not an <input>, <textarea> or contenteditable element (<role>)` |

The walker records `editable: true` on a ref whose element is `isContentEditable`, in state only;
it does not change the printed tree. `click`, `hover` and the other ref commands accept any ref.
`src/cli.ts`'s user-error regex covers the new messages.

## Acceptance (public seams only)

1. **Renderer, through `cmdSnapshot`** (`tests/commands.test.ts` or `tests/snapshot.test.ts`,
   `fakeClient` returning the walker's tree JSON for `evaluate`): the wrapper bytes, the title
   omission, `--json`, `--filename`, every attribute in 3.2 and its order, key single-quoting,
   value double-quoting and escaping, inline vs block form, props, `--depth` including 0 and
   invalid values.
2. **Walker, through the real browser** (e2e, `BOWSER_E2E=1`, both backends in CI): golden files
   under `tests/fixtures/snapshots/` for `todo-app.html` (fresh, after adding "buy milk", after
   toggling it) and `kitchen-sink.html` (fresh), compared byte-for-byte with bowser's tree. Each
   golden is the tree from the playwright-cli capture of the same page, unchanged except for the
   deviations this spec rules. The only deviations allowed are:
   - no `- Console:` line (it is not part of the tree anyway);
   - the viewport paragraph in kitchen-sink: the test sets the viewport to 1280×720 first with
     bowser's `resize`, so the text matches;
   - any other difference must be listed in the golden's header comment in the test and ruled in
     the ledger, with the reason (for example a layout difference between WebKit and Edge).
3. **Refs**: sticky across two snapshots of the todo page (after adding a todo, `Clear
   completed` keeps its ref, new nodes get new numbers), and the new refs drive the existing
   actions (`fill`, `click`, `check`) on both backends.
5. **Wrong-kind refs** (§5): unit tests through `cmdCheck`, `cmdUncheck`, `cmdSelect`, `cmdFill` with
   a seeded state and a `fakeClient` show each command rejects a mismatched ref with the message
   above and sends no daemon request, and accepts each listed kind; one test through the CLI's
   error classification shows exit code 1. One e2e step on the todo page: `check` on the
   `listitem` ref fails and the todo stays unchecked.
4. Existing e2e substring matchers (`"Add": [ref=` etc.) and `tests/e2e-compat.test.ts`'s
   line regex are updated to the new syntax; the whole e2e suite passes on both backends.

## Docs

README and `skills/bowser/SKILL.md` snapshot examples, CLAUDE.md (the "Snapshot output is
aria-tree YAML…" convention, the `--depth` rule, the e2e-compat note), and a CHANGELOG entry
marked **Breaking** (new line syntax, full tree, new ref numbering, `--json` shape, `--depth=0`
now valid).

## Out of scope

playwright-cli's global `--raw` flag (tree only, no wrapper); the `### Page` wrapper on other
commands' output; console capture and the `- Console:` line; `### Events` and other sections; iframes' contents
and `f1eN` refs; shadow DOM; `aria-owns`; `snapshot <ref>` (subtree snapshots); `--boxes`;
incremental snapshots.
