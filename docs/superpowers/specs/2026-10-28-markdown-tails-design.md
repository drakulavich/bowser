# `markdown`: absolute links in a page's own Markdown, empty pages under `--filename`, task-list state (#154)

**Issue:** #154 (ET-50, ET-51, ET-55; the decision is in the
[2026-10-28 comment](https://github.com/drakulavich/bowser/issues/154#issuecomment-6467636582)).
**Status:** draft for review.

## Problem

Three things `markdown` does today make Sora believe something false about a page. Each was rechecked on
2026-10-28 with bowser at main 3d7c776:

- **ET-50.** The page's own Markdown (`source: "page"`) keeps the site's relative links, and the text form
  prints no base URL. `https://bun.com/docs/runtime/http/server` gives `](/bundler)`, `](/bundler/fullstack)` and
  `](./tls)`; Sora has to work out the absolute URL itself. (code.claude.com, the campaign's other site, has
  since moved to absolute links: 65 of its 80.)
- **ET-51.** On a page with no text, `markdown --filename=f` writes a 1-byte file and answers `wrote /abs/f`;
  `--json` answers `{"ok":true,"filename":"…","source":"converted"}`. Without `--filename` the same page gives
  `markdown: the page has no text ("", about:blank)` (#138). `--filename` is the path the README gives for big
  pages, so Sora believes it saved a page that had nothing on it.
- **ET-55.** Checkbox `input`s are skipped, so a done and an open task read the same. Issue #140's body has
  `- [ ] S2-2`, `- [ ] S2-3`, `- [ ] S2-4`; `markdown` on its GitHub page prints `- S2-2: …` with no state.

## Change

### ET-50: links in the page's own Markdown become absolute

When the result comes from the page's own Markdown (the claude.ai artifact or the `rel="alternate"` link in
`markdownScript`, `src/page-scripts.ts`), each inline link or image target without a scheme is resolved with
`new URL(target, base)`:

- `base` is the Markdown's own URL: `link.href` for the alternate link, the page's `location.href` for an
  artifact (whose content comes from an API URL that is not a document base).
- A target is rewritten when it is not empty, does not start with a scheme (`/^[a-z][a-z0-9+.-]*:/i`) and does
  not start with `#`. `/x`, `./x`, `../x`, `x` and `//host/x` are resolved; `https:`, `mailto:`, `vscode:`,
  `#frag` and an empty target (`[t]()`) stay as written.
- When `new URL` throws (`[a](///)` does), the target stays as written: one bad link must not cost the page.
- Only the target is replaced. A link is `(`, optional whitespace (spaces or tabs), the target (`<…>`, which may
  hold spaces but not `<`, `>` or a newline, or else a run with no whitespace), then optionally whitespace and a
  title in one of CommonMark's three forms (`"…"`, `'…'`, `(…)`), then `)`. The title and
  `<…>` brackets are kept as written. A link that does not fit that shape is left alone.
- Code is left byte for byte: inline code spans, and fenced code blocks as CommonMark defines them. A fence
  opens on a line indented by up to three spaces, or nested in a list item, with three or more backticks or
  tildes, and closes on a line of the same character at least as long; an unclosed fence runs to the end.
  Indented code blocks (four spaces, no fence) are not detected, since inside a list the same indent is plain
  continuation text.

`--json` keeps `source: "page"`. The rest of the text is unchanged, so the result is no longer byte-identical
to `curl` of the `.md` only where a relative link was.

### ET-51: the empty-page line under `--filename`

`--filename` on a page with no text still writes the file, and answers on two lines:

```
markdown: the page has no text ("", about:blank)
wrote /abs/empty.md
```

`--json` with `--filename` always carries `url`, `title` and `empty`:
`{"ok":true,"filename":"/abs/f","source":"converted","url":"…","title":"…","empty":true}`. `empty` is `false`
whenever the file holds Markdown. A ref with no text gives the ref form of the line
(`markdown: ref 'e5' has no text (…)`), as without `--filename`.

### ET-55: a checkbox in a list item prints its state

A checkbox `input` inside an `li` prints `[x] ` when checked and `[ ] ` when not, where it stands in the item.
It follows the other skip rules (`hidden`, `aria-hidden="true"`, `display: none` still drop it); every other
`input` is still skipped. `- [ ] S2-2: …` is the GFM task-list form, so a renderer shows it as a task.

GitHub renders #140's three tasks inside one `li`, so they stay one item with continuation lines, each now
carrying its state. Splitting them is #133's job (taking GitHub's own Markdown), not the converter's.

## Cost

No stored data changes. ET-50 adds one pass over the page's Markdown with a regular expression, skipping code;
a 20 KB document is far below the time `markdown` already takes (26 to 364 ms in the 2026-10-14 campaign).
ET-51 and ET-55 add no reads.

## Not in scope

- Reference-style link definitions (`[t]: /x`): zero on both sites checked.
- Raw HTML `<a href>` or `<img src>` inside the Markdown.
- Catching a site's own wrong link (`/bundler` is 404 at `https://bun.com/bundler` either way); that would need
  the page's links compared with the Markdown's.
- Custom-drawn checkboxes with no `input`, or a hidden native `input` behind a drawn box.
- ET-54 (U+200B in Mintlify headings) and ET-08 (#81): decided won't do.

## Definition of Done

- `tests/e2e-markdown.test.ts`, on fixture pages served by the test's server:
  - an alternate link to `/md/guide.md` from the page `/docs/page.html`, whose Markdown holds `[a](/x)`,
    `[b](./y)`, `[c](../z)`, `[d](w "t")`, `[d2](w 't')`, `[d3](w (t))`, `[e](<sp ace>)`, `![i](img.png)`,
    `[p](//cdn.example/a)`, `[v](vscode:ext)`, `[m](mailto:a@b.c)`, `[f](#sec)`, `[h](https://e.com/q)`, `[n]()`,
    `[u](///)`, a backtick fence at column 0 with `[k](/k)`, a list item whose body is a tilde fence indented
    three spaces with `[k2](/k2)` and closed by a longer run, and an inline code span `` `[j](/j)` ``:
    `markdown --json` answers `source: "page"` and a `markdown` string written out in the test, with
    `<base>/x`, `<base>/md/y`, `<base>/z`, `<base>/md/w "t"`, `<base>/md/w 't'`, `<base>/md/w (t)`,
    `<<base>/md/sp%20ace>` (as `new URL` encodes it), `<base>/md/img.png`, `http://cdn.example/a` (the fixture
    server is `http:`), and every other target, both fences and the code span unchanged;
  - `about:blank` with `--filename`: the file holds exactly one newline, the text reply is the two lines above,
    and `--json` has `url: "about:blank"`, `title: ""`, `empty: true`; on a page with text, `empty: false` and its
    `url` and `title`;
  - a ref to an empty element with `--filename`: the text reply starts `markdown: ref 'eN' has no text (`;
  - a list with a checked and an unchecked checkbox, a hidden checkbox, and a checkbox outside any `li`:
    `- [x] done`, `- [ ] open`, the hidden one and the outside one print no state.
- The existing `--filename` test (`tests/e2e-markdown.test.ts`, "--filename writes the Markdown…") changes its
  expected `--json` object to the new fields.
- `BOWSER_E2E=1 BOWSER_E2E_NET=1`: on `https://bun.com/docs/runtime/http/server`, `markdown --json` has
  `source: "page"` and no `](/` or `](./` outside code; today it has `](/bundler)`, `](/bundler/fullstack)`,
  `](./tls)`. On `https://github.com/drakulavich/bowser/issues/140`, the output holds `[ ] S2-2`; today it holds
  `- S2-2: a table`.
- The README row for `markdown` says that links in the page's own Markdown are made absolute, and names `empty`;
  `skills/bowser/references/commands.md` likewise. `docs-drift` passes.
- `bun run check` and `BOWSER_E2E=1 bun test` pass (CI e2e).
- Each new test goes red under one mutation of the line it names, quoted in the PR.

## Open Issues

- Whether a GitHub task list still renders as one `li` holding several tasks was not rechecked: on 2026-10-28
  #140's page printed the tasks as separate lines. The network check asserts only the state, so it holds either
  way.
