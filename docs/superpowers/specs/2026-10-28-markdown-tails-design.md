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
  `--json` answers `{"ok":true,"filename":"…","source":"converted"}`, the same reply as for any saved page.
  Without `--filename` the same page gives `markdown: the page has no text ("", about:blank)` (#138).
  `--filename` is the path the README gives for big pages, so this is the reply Sora sees on most long reads.
- **ET-55.** Checkbox `input`s are skipped, so a done and an open task read the same. Issue #140's body has
  `- [ ] S2-2`, `- [ ] S2-3`, `- [ ] S2-4`; `markdown` on its GitHub page prints `- S2-2: …` with no state.

## Change

### ET-50: path-relative links in the alternate Markdown become absolute

When the result comes from the `rel="alternate"` link in `markdownScript` (`src/page-scripts.ts`), each inline
link or image target that starts with `/`, `./` or `../` is replaced with `new URL(target, link.href)`:

- The target is the run after `](<` up to `>`, or else the run after `](` up to the first whitespace or `)`.
  Only that run is replaced, so a title after it and the `<…>` brackets stay as written, and every other target (a scheme,
  `#frag`, an empty one, a bare `x`) is never matched.
- `//host/x` starts with `/`, so it is matched and resolved to the base's scheme.
- When `new URL` throws (`[a](///)` does), the target stays as written.
- Code is left byte for byte: inline code spans, and fenced code blocks as CommonMark defines them:
  - a fence opens on a line whose first non-blank characters are three or more backticks or tildes, at any
    indent (more lenient than CommonMark, which caps the indent: a doubtful line keeps its links as written);
  - it closes on a line of the same character, at least as long as the opener;
  - an unclosed fence runs to the end of the document;
  - indented code blocks (four spaces, no fence) are not detected, since inside a list the same indent is plain
    continuation text.

`--json` keeps `source: "page"`.

### ET-51: the empty-page line under `--filename`

`--filename` on a page with no text still writes the file, and answers on two lines:

```
markdown: the page has no text ("", about:blank)
wrote /abs/empty.md
```

`--json` with `--filename` always carries `url` and `title`:
`{"ok":true,"filename":"/abs/f","source":"converted","url":"…","title":"…"}`. A ref with no text gives the ref
form of the line (`markdown: ref 'e5' has no text (…)`), as without `--filename`.

### ET-55: a checkbox in a list item prints its state

A checkbox `input` inside an `li` prints `[x] ` when checked and `[ ] ` when not, where it stands in the item,
even when the checkbox itself is hidden: GitHub draws a read-only task with its checkbox at `display: none`
(checked on #140 on 2026-10-28), and custom-drawn checkboxes hide the native `input` the same way. A hidden
`li` still drops the whole item. Every other `input` is still skipped. GitHub serves two markups for the same
task list (seen on #140 on 2026-10-28): in one the task text is a block after the checkbox, so the item reads
`- [ ]` with the text on the next line; the state is there either way. When the checkbox comes first in the item, as on GitHub, `- [ ] S2-2: …` is the GFM
task-list form and a renderer shows it as a task.

## Cost

No stored data changes; one regular-expression pass over the alternate Markdown, no new reads or waits.

## Not in scope

- Bare relative targets (`[t](x)`, `![i](img.png)`): none on the two sites checked.
- Reference-style definitions (`[t]: /x`): zero on the two sites checked.
- Raw HTML `<a href>` or `<img src>` inside the Markdown: not counted.
- A claude.ai artifact's Markdown: its content comes from an API URL that is not a document base.
- Catching a site's own wrong link (`/bundler` is 404 at `https://bun.com/bundler` either way); that would need
  the page's links compared with the Markdown's.
- Custom-drawn checkboxes with no `input` at all.

## Definition of Done

- `tests/e2e-markdown.test.ts`, on fixture pages served by the test's server:
  - an alternate link to `/md/guide.md` from the page `/docs/page.html`: `markdown --json` answers
    `source: "page"` and a `markdown` string written out in the test. `<base>` is the fixture server's origin
    (`http://localhost:<port>`):

    | In the Markdown | In the result |
    |---|---|
    | `[a](/x)` | `[a](<base>/x)` |
    | `[b](./y "t")` | `[b](<base>/md/y "t")` |
    | `[c](../z)` | `[c](<base>/z)` |
    | `![i](<./sp ace.png>)` | `![i](<<base>/md/sp%20ace.png>)` (as `new URL` encodes it) |
    | `[p](//cdn.example/a)` | `[p](http://cdn.example/a)` |
    | `[u](///)` | unchanged |
    | `[h](https://e.com/q)` | unchanged |
    | `[w](x)` | unchanged |
    | a backtick fence at column 0 holding `[k](/k)` | unchanged |
    | a list item whose body is a tilde fence indented three spaces, holding `[k2](/k2)`, closed by a longer run | unchanged |
    | an inline code span `` `[j](/j)` `` | unchanged |

  - `about:blank` with `--filename`: the file holds exactly one newline, the text reply is the two lines above,
    and `--json` has `url: "about:blank"` and `title: ""`; on a page with text, its `url` and `title`;
  - a ref to an empty element with `--filename`: the text reply starts `markdown: ref 'eN' has no text (`;
  - a list with a checked and an unchecked checkbox, a checked one with `hidden`, an unchecked one at
    `display: none`, and a checkbox outside any `li`: `- [x] done`, `- [ ] open`, `- [x] hid`, `- [ ] styled`, and the
    outside one prints no state.
- The existing `--filename` test (`tests/e2e-markdown.test.ts`, "--filename writes the Markdown…") changes its
  expected `--json` object to the new fields.
- `BOWSER_E2E=1 BOWSER_E2E_NET=1`: on `https://bun.com/docs/runtime/http/server`, `markdown --json` has
  `source: "page"` and no `](/` or `](./` outside code; today it has `](/bundler)`, `](/bundler/fullstack)`,
  `](./tls)`. On `https://github.com/drakulavich/bowser/issues/140`, the output matches `/\[ \]\s+S2-2/`; today it holds
  `- S2-2: a table`.
- The README row for `markdown` says that path-relative links in the page's own Markdown are made absolute;
  `skills/bowser/references/commands.md` likewise. `docs-drift` passes.
- `bun run check` and `BOWSER_E2E=1 bun test` pass (CI e2e).
- Each new test goes red under one mutation of the line it names, quoted in the PR.
