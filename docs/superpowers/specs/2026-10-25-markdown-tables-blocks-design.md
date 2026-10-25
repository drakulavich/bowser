# markdown: spanned cells, data tables and block content inside inline elements (ET-45, ET-46, ET-47, #154)

## Problem

The 2026-10-14 campaign (`docs/superpowers/exploratory-testing/2026-10-14-session-log.md`, session S3) found
three ways `markdown` changes what a page says. All three are in `TO_MARKDOWN` in `src/page-scripts.ts`.

- **ET-45 (P2).** `table()` puts each row's cells side by side and ignores `rowspan` and `colspan`. Every cell
  after a spanned one moves one column left. On Wikipedia's "List of tallest buildings", the row after a
  `rowspan=3` "China" reads Country "555 m" and Height (m) "1,821 ft". On "List of Nobel laureates in Physics",
  Marie Curie's citation sits under "Country" (3 runs, 2 pages).
- **ET-46 (P2).** `layoutTable()` calls a table a layout table if any element inside any cell is block-level,
  including elements the converter skips. One `div.center` in an image cell turns the 100-row tallest-buildings
  table into one value per paragraph, with no column names. Its second header row (`th` "m", `th` "ft") then
  matches the key-value rule and prints `m: ft`. A navbox's collapse `button` (display block, skipped) does the
  same to every navbox (2 runs).
- **ET-47 (P2).** `inline()` joins a block-level child to its neighbours with no separator. An inline `<a>`
  wrapping a `div` and an `h3` prints `[BloodlinesWhat is state capture …](…)` (Guardian, BBC). The
  2302 `<emu-alg>` elements on tc39.es/ecma262 are `display: inline` and wrap an `ol`, so each algorithm prints
  as one line with its step numbers and nesting gone (3 sites).

## Change

### 1. Spanned cells take every place they cover (ET-45)

`table()` first builds a grid. It walks the rows in order, and puts each cell in the row's first free column.
A cell covers `cell.rowSpan` rows and `cell.colSpan` columns: the DOM properties, not the attributes, so
`colSpan` is already clamped to 1–1000 (`colspan="0"` and `colspan="100000000"` read as 1 and 1000) and
`rowSpan` to 0–65534. A row span stops at the end of the cell's row group (`thead`, `tbody` or `tfoot`, or
the table when rows have no group), and `rowSpan` 0 means the rest of that group, as in HTML. A `thead`
cell never reaches into the body. Its text goes in every covered place in its first column, so each row below a
`rowspan` cell repeats its value. The other columns it covers stay empty.

So the row after "China" reads `| 3 | Ping An Finance Center | Shenzhen | China | 555 m | …`. Wikipedia's
header is `Rank`, `Building` and `Country` with `rowspan=2`, then `Height` with `colspan=2`, over a second
row `m | ft`. It prints as `| Rank | Building | Country | Height | |` over `| Rank | Building | Country | m | ft |`.
Without those row spans, `m` and `ft` would land under Rank and Building, which is also what a browser
shows.

The value repeats down a `rowspan` because an agent reads a row on its own, and an empty Country cell would
read as "no country". Across a `colspan` it does not repeat: a note spanning a whole row would otherwise print
once per column.

**Cost.** The grid holds one string per covered place: a table of R rows and C columns is R×C strings, the
same as the Markdown it prints. The 100-row tallest-buildings table is about 1,000 cells. Because of the
clamps, one cell adds at most 1000 columns, and a row span never outgrows its group, so a hostile span costs
no more than a table that size written out.

### 2. A table is data when its first row is a header row, or when no printed cell holds a block (ET-46)

`layoutTable(el)` returns false (a data table) when:

- the first row that is not skipped has only `th` cells and at least two of them. The infobox the fixture pins,
  `<tr><th>Developer</th><td>…</td></tr>`, starts with `th` and `td`, so it stays a key-value table; or
- no cell holds a block-level element that the converter would print. An element counts only if neither it
  nor any ancestor up to the cell is `skipped()`, and `isBlock()` holds for it. The navbox `button` is
  skipped, so it no longer counts.

A data table whose cells hold blocks prints each cell through `inline()`, as data cells do today, with
newlines turned into spaces. Item 3 puts a space between the blocks, so the text stays separate, and each
cell's runs of whitespace now fold into one space (today `table()` folds only around newlines).

The tradeoff: a real layout table whose first row is two or more `th` cells, with a list in a later cell, now
prints as a Markdown table, and the list's items run together in one cell. The campaign found no such table,
and the pages it read put their infoboxes in `th` + `td` rows.

### 3. Block content inside an inline element stays apart (ET-47)

- **In `inline()`**: a child element for which `isBlock()` holds is wrapped in a space on each side. Link text
  then reads `[Bloodlines What is state capture …](…)`. The spaces fold into one: a paragraph's whitespace
  already collapses in `convert()`, and a table cell's does after item 2.
- **In `blocks()`**: an element that is not block-level, is not `A`, and has a direct child element for which
  `isBlock()` holds, is walked as a block, the same way as `div`. `<emu-alg>` then prints its `ol` as a list. An
  `A` stays inline, so its URL is kept and its text gets the spaces from the first point.

## Tests

In `tests/e2e-markdown.test.ts`, one new fixture page, `/tables.html`, and one test per item. Each test fails
on `main`.

- **ET-45.** The Wikipedia shape: `Rank`, `Building` and `Country` headers with `rowspan=2`, `Height` with
  `colspan=2` over `m | ft`, then two body rows that share a `rowspan=2` Country "China". The whole expected
  table is written in the test:
  `| Rank | Building | Country | Height | |`, `| --- | --- | --- | --- | --- |`,
  `| Rank | Building | Country | m | ft |`, `| 1 | A | China | 632 m | 2,073 ft |`, `| 2 | B | China | 599 m | 1,965 ft |`.
- **ET-45, row groups and clamps.** `<thead><tr><th rowspan="0">Year</th><th>Name</th></tr></thead>
  <tbody><tr><td>1903</td><td>Curie</td></tr></tbody>` prints the body row as `| 1903 | Curie |`, and a body
  cell with `colspan="0"` and one with `colspan="1001"` take 1 and 1000 columns (the test checks the column
  count of the separator line and that the command returns).
- **ET-46, header row.** A data table with a header row and a `<div>` in one data cell prints as a Markdown
  table, not as paragraphs, and prints no `m: ft` line.
- **ET-46, skipped block.** A data table with no header row and a `display: block` `<button>Toggle</button>` in
  one cell prints as a Markdown table, and `Toggle` is not in the output. A second table with a `hidden`
  wrapper around a `<p>` in one cell prints as a Markdown table too.
- **ET-46, whitespace.** A data cell `Hello <div>World</div>` under a header row prints `Hello World` with one space.
- **ET-46, infobox unchanged.** The existing `Developer: Apple` / `Engine: WebKit` assertion in the fidelity test
  stays as it is.
- **ET-47, link.** `<a href="/story"><div>Bloodlines</div><h3>What is state capture</h3></a>` prints
  `[Bloodlines What is state capture](<base>/story)`.
- **ET-47, inline wrapper.** `<emu-alg style="display: inline"><ol><li>One</li><li>Two</li></ol></emu-alg>` prints
  `1. One\n2. Two`.

The existing e2e Markdown tests stay green.

## Out of scope

The rest of #154: ET-48 (block links lose their URL), ET-49 (code fence languages), ET-62 (`<ol start>`),
ET-50 and ET-51 (decisions), ET-54 and ET-55 (observations). ET-61 is #204.

## Definition of Done

| Command | Expected |
| --- | --- |
| `BOWSER_E2E=1 bun test tests/e2e-markdown.test.ts -t "ET-45"` | the new test passes |
| `BOWSER_E2E=1 bun test tests/e2e-markdown.test.ts -t "ET-46"` | the new tests pass |
| `BOWSER_E2E=1 bun test tests/e2e-markdown.test.ts -t "ET-47"` | the new tests pass |
| `BOWSER_E2E=1 bun test tests/e2e-markdown.test.ts` | 0 fail |
| `bun run check` | 0 fail |
