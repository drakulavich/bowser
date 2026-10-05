# `markdown`: the page as Markdown (#130, #131)

**Issues:** #130, #131.
**Status:** draft for review.

## Goal

An agent that needs to read a page, not act on it, gets the page as Markdown at a fraction of the cost of `snapshot`. When the page offers its own Markdown, the agent gets that text. Otherwise bowser converts the rendered DOM. `markdown <ref>` converts one element's subtree, so the agent can leave navigation and footers out.

## What the measurement showed

The numbers are in the [#130 comment](https://github.com/drakulavich/bowser/issues/130#issuecomment-5992080616). In short:

- A ~100-line DOM walker run through `run-code` produced Markdown at 17–37% of `snapshot`'s bytes on six general pages, and 73% on a claude.ai artifact.
- A claude.ai artifact's own Markdown comes from `fetch('/api/published_artifacts/<uuid>')` inside the page, as `{title, description, type, content}`. The page makes this request itself. Without a browser the URL answers 403.
- `<link rel="alternate" type="text/markdown">` was on 2 of 7 pages (bun.sh docs, Claude Code docs).
- Chrome is a real cost: 37% of MDN's conversion and 19% of GitHub's comes before the title. Converting only `<main>` cuts MDN from 21.2k to 7.0k bytes and barely changes the rest, because their `<main>` holds navigation too.

## Design

### 1. The command

```
bowser markdown [<ref>] [--filename=f]
```

- The text form prints the Markdown and nothing else, with no `### Page` wrapper, so it can be piped.
- `--json` prints `{"markdown": "…", "source": "page" | "converted"}`.
- `--filename=f` writes the Markdown to `f` and answers `wrote /abs/f`, or `{"ok":true,"filename":"/abs/f","source":…}` under `--json`, the same way `snapshot --filename` does.
- The registry entry makes it an MCP tool, like every other command.
- Long pages are printed in full. `--filename` is the way to keep a big page out of the agent's context.

`markdown` is a reading op, like `snapshot`. It is not in `ACTS`, and without a ref it does not wait for a pending navigation.

### 2. Picking the source (no ref)

`MARKDOWN_SCRIPT` in `src/page-scripts.ts` is one async expression evaluated in the page. It tries, in order:

1. **A claude.ai artifact.** The page is on `claude.ai` and its path is `/public/artifacts/<uuid>`. The script fetches `/api/published_artifacts/<uuid>`. When the answer is 200 and its `type` is `text/markdown`, `content` is the result, with `source: "page"`. A React or HTML artifact, or any failed fetch, falls through to the next step.
2. **`<link rel="alternate" type="text/markdown" href>`.** The script fetches `href` from the page, so the session's cookies apply. A 200 whose body is not an HTML document is the result, with `source: "page"`. A failure, including a CORS refusal on another origin, falls through.
3. **Conversion** of `main, [role=main]` (the first visible match) or else `document.body`, with `source: "converted"`.

Each fetch counts against the op's budget. The command never waits on a fetch longer than the remaining budget: a fetch still running when the budget is half spent is abandoned, and the script converts instead.

### 3. The conversion

The walker follows the prototype in the #130 comment:

- **Skipped:** an element that is hidden (the `hidden` attribute, `aria-hidden="true"`, computed `display: none` or `visibility: hidden`), and `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `iframe`, `button`, `input`, `select`, `textarea`. Iframe contents and shadow DOM are not walked, as in `snapshot`.
- **Blocks:** `h1`–`h6` → `#`…`######`; paragraphs and block-level boxes become paragraphs separated by a blank line; `ul`/`ol` → `- ` / `1. `, nested by indentation; `pre` → a fenced block holding its `innerText`; `blockquote` → `> `; `hr` → `---`.
- **Inline:** `strong`/`b` → `**…**`; `em`/`i` → `*…*`; `code` → `` `…` ``; `a[href]` → `[text](absolute href)`; an `img` with `alt` → `![alt]`; `br` → a line break. A link to `#…` or `javascript:` keeps its text without the URL. A heading permalink whose text is only `#`, `¶` or `🔗` is dropped. The prototype printed `## Basic Setup#` on bun.sh.
- **Tables:** a `table` becomes a Markdown table when none of its cells holds a block element or another table. Otherwise it is a layout table, and its cells convert as blocks. On Hacker News the prototype printed the front page as one broken table.
- **Whitespace:** runs of whitespace collapse to one space outside `pre`. No more than one blank line in a row.

Link URLs are kept. They are most of the bytes on link-heavy pages (Wikipedia 58.9k with them, 30.5k without), but an agent reading a page needs them to go anywhere from it.

### 4. `markdown <ref>`

With a ref, the command converts the ref's element and its subtree (section 3) and skips the source lookup. `source` is always `"converted"`. The ref goes through `liveSelector` without `enabled` or `hit`, so a ref from another document, a ref whose element is gone or changed, and the pending-navigation wait behave and fail exactly as they do for `click` (#105, #80). Then one `evaluate` converts `document.querySelector(selector)`. `resolveRefScript` may scroll the element into view, which a reading command does not need. That stays rather than adding an option for it.

## Definition of done

1. **Conversion.** An e2e test on a new fixture, `tests/fixtures/markdown.html`, checks the exact Markdown for headings, a nested list, an ordered list, a data table, a layout table, `pre`, inline `code`, emphasis, an absolute and a `#` link, a heading permalink, an image with and without `alt`, a hidden element, `aria-hidden`, a `<nav>` outside `<main>`, and form controls.
2. **`<main>`.** On the fixture the `<nav>` outside `<main>` is absent. On a copy with no `<main>`, it is present.
3. **`rel=alternate`.** A local `Bun.serve` page with `<link rel="alternate" type="text/markdown" href="/page.md">` gives `/page.md`'s body with `"source":"page"`. When `/page.md` answers 404, or answers with an HTML body, the result is the conversion with `"source":"converted"`.
4. **Artifact.** A live test gated like `tests/e2e-search.test.ts` (`BOWSER_E2E_NET=1`) opens the #130 example artifact and gets Markdown that starts with `# Aqara W400` and has `"source":"page"`.
5. **Ref.** `markdown <ref>` on the fixture's `<article>` gives only the article. A ref from before a `goto` fails with `ref 'eN' is from a page that is no longer loaded; take a new snapshot`, exit 1.
6. **Output forms.** The text form has no `### Page` wrapper. `--json` and `--filename` answer as in section 1. `tests/mcp.test.ts` lists a `markdown` tool.
7. **Size.** On the fixture, the conversion is less than half of `snapshot`'s bytes.
8. **Checks.** `bun run check` and `BOWSER_E2E=1 bun test` pass. CI is green.
9. **Docs.** The README command reference, `skills/bowser/SKILL.md` and CHANGELOG `[Unreleased]` describe `markdown`, and the roadmap gets a ticked line.
10. **Review and issues.** A Codex review ends with no open Critical or Required finding. The PR closes #130 and #131.

## Out of scope

- Main-content heuristics such as Readability: they would inject third-party code and can miss on pages with no `<main>`.
- Refs in the Markdown: `snapshot` stays the way to act.
- Iframe and shadow DOM contents.
- Truncation or a size limit.
- Site adapters other than claude.ai artifacts. Each gets its own issue when a real case comes up.

## Possible later

- Adapters for GitHub (raw README) and docs sites that serve `<path>.md` without a `rel=alternate` link.
- A flag that drops link URLs, for pages where the agent only reads.
