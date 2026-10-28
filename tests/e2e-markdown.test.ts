// End-to-end: `markdown` prints the page as Markdown, from the page's own
// Markdown when it offers some, else converted from the DOM. Spec:
// docs/superpowers/specs/2026-10-05-markdown-command-design.md.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-markdown.test.ts
// The claude.ai artifact case also needs BOWSER_E2E_NET=1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdMarkdown, cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;
const runOrSkipNet = E2E && process.env.BOWSER_E2E_NET === "1" ? describe : describe.skip;
const FIXTURES = join(import.meta.dir, "fixtures");

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

const TALL = `<!doctype html><title>tall</title><div style="height: 3000px">Top</div><article><p>Far below</p></article>`;
const HIDDEN = `<!doctype html><title>hidden</title><p><code>shown<span hidden>secret</span></code></p><pre>a<span style="display: none">secret</span>b</pre><table><tr hidden><td>secret</td></tr></table><p>after</p>`;
const EDGES =
  "<!doctype html><title>edges</title><main><h2>Heading ref</h2><p><strong>bold </strong>text and <em> it</em>alic</p><table><tr><th>A</th><th>B</th></tr><tr><td>a<br>b</td><td>c</td></tr></table><p><code>a`b</code></p><pre>before\n```\nafter</pre></main>";
const FIDELITY = `<!doctype html><title>Fidelity</title><main>
<p><del>$99</del> <s>old</s> <strike>gone</strike> $49</p>
<table><caption>Prices</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>
<div style="visibility: hidden">hidden parent <span style="visibility: visible">shown child</span></div>
<details><summary>More</summary><p>closed body</p></details>
<details open><summary>Open</summary><p>open body</p></details>
<p># not a heading</p>
<p>1. not a list</p>
<p>- dash and &lt;b&gt;tag</p>
<p>H<sub>2</sub>O x<sup>2</sup></p>
<div class="highlight-python3"><pre>print(1)</pre></div>
<pre><code class="language-js">let a</code></pre>
<p><img src="/a.png" alt="A [b]"> <img src="data:image/png;base64,AAAA" alt="D"></p>
<table><tr><td></td></tr></table>
<div style="white-space: pre">line one
line two</div>
<table><tr><th>Developer</th><td><div>Apple</div></td></tr><tr><th>Engine</th><td><div>WebKit</div></td></tr></table>
</main>`;
const REVIEW = `<!doctype html><title>review</title><main><table><tr><th>Key <details><summary>more</summary>secret</details></th><td><p>v</p></td></tr></table><div style="visibility: hidden"><img alt="hidden" src="h.png"><hr></div><table><tr><th>List</th><td><ul><li>A</li><li>B</li></ul></td></tr><tr><th>Lines</th><td><p>one<br>two</p></td></tr></table><p><img alt="pic" src="image)a.png"> <a href="x)y(z.html">link</a></p></main>`;
// #154: the page structures the 2026-10-14 campaign found misreported (ET-45 to ET-62).
const SPANS = `<!doctype html><title>spans</title><main>
<table><tr><th>Rank</th><th>Building</th><th>Country</th><th colspan="2">Height</th></tr>
<tr><td>1</td><td>Shanghai Tower</td><td rowspan="2">China</td><td>632 m</td><td>2,073 ft</td></tr>
<tr><td>2</td><td>Ping An</td><td>599 m</td><td>1,965 ft</td></tr></table>
<table><tr><td rowspan="2">a</td><td>b</td><td rowspan="2">c</td></tr><tr><td colspan="2">d</td><td>e</td></tr></table>
<table><tr><td rowspan="0">f</td><td>g</td></tr><tr><td>h</td></tr></table>
<table><thead><tr><th rowspan="2">K</th><th>V</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<table><tr><td rowspan="2">p</td><td>q</td></tr><tr style="display: none"><td>r</td></tr><tr><td>s</td><td>t</td></tr></table>
</main>`;
const DATA = `<!doctype html><title>data</title><main>
<table><tr><th>Name</th><th>Image</th></tr><tr><td>Burj</td><td><div class="center"><img alt="pic" src="/b.png"></div></td></tr></table>
<table><tr><td>a <button style="display: block">toggle</button></td><td>b</td></tr></table>
</main>`;
const GLUED = `<!doctype html><title>glued</title><main>
<div><a href="/g"><span style="display: block">Bloodlines</span><span>What is it?</span></a></div>
<emu-alg><ol><li>If x, then<ol><li>Let y.</li></ol></li><li>Return y.</li></ol></emu-alg>
<div><a href="/issues" style="display: flex"><span>Issues</span><span>(3.6k)</span></a></div>
<p><strong><span style="display: block">Warning</span></strong></p>
</main>`;
const LANGS = `<!doctype html><title>langs</title><main>
<div class="highlight highlight-source-shell"><pre>bun add x</pre></div>
<div class="mw-highlight mw-highlight-lang-python"><pre>print(2)</pre></div>
</main>`;
const LISTS = `<!doctype html><title>lists</title><main>
<ol start="5"><li>five</li><li>six</li></ol>
<ol reversed><li>a</li><li hidden>gone</li><li>b</li></ol>
<ol><li value="10">ten</li><li>eleven</li></ol>
</main>`;
const ALT = (href: string) => `<!doctype html><title>alt</title><link rel="alternate" type="text/markdown" href="${href}"><main><p>Rendered</p></main>`;

runOrSkip("e2e: markdown", () => {
  const ctx: CommandContext = { session: "markdown", json: false };
  const json: CommandContext = { ...ctx, json: true };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-markdown-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/fixture.html") return html(await readFile(join(FIXTURES, "markdown.html"), "utf8"));
        if (path === "/watch") return html(await readFile(join(FIXTURES, "youtube-watch.html"), "utf8"));
        if (path === "/no-main.html") {
          const page = await readFile(join(FIXTURES, "markdown.html"), "utf8");
          return html(page.replace("<main>", "<div>").replace("</main>", "</div>"));
        }
        if (path === "/tall.html") return html(TALL);
        if (path === "/hidden.html") return html(HIDDEN);
        if (path === "/edges.html") return html(EDGES);
        if (path === "/alt.html") return html(ALT("/page.md"));
        if (path === "/alt-missing.html") return html(ALT("/missing.md"));
        if (path === "/fidelity.html") return html(FIDELITY);
        if (path === "/review.html") return html(REVIEW);
        const fidelity = {
          "/spans.html": SPANS,
          "/data.html": DATA,
          "/glued.html": GLUED,
          "/langs.html": LANGS,
          "/lists.html": LISTS,
        }[path];
        if (fidelity) return html(fidelity);
        if (path === "/blank.html") return html("<!doctype html><title>Just a moment...</title><main></main>");
        if (path === "/alt-slow.html") return html(ALT("/slow.md"));
        if (path === "/slow.md") {
          await Bun.sleep(20_000);
          return new Response("# Late");
        }
        if (path === "/alt-signin.html") return html(ALT("/private.md"));
        if (path === "/private.md") return Response.redirect("/signin.html", 302);
        if (path === "/signin.html") return html("<!doctype html><title>Sign in</title><form>Sign in</form>");
        if (path === "/alt-shell.html") return html(ALT("/shell.md"));
        if (path === "/shell.md") return html("<!doctype html><div id=root>Loading</div>");
        if (path === "/alert.html")
          return html("<!doctype html><title>alert</title><main><p>Alert page</p></main><script>setTimeout(() => alert('hello'), 300)</script>");
        if (path === "/page.md") return new Response("# From source\n\nText.\n", { headers: { "content-type": "text/markdown" } });
        return new Response("not found", { status: 404 });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const refOfRole = async (role: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.role === role);
    if (!r) throw new Error(`no ${role} ref in the last snapshot`);
    return r.id;
  };

  test("converts <main>: blocks, inline marks, tables, and nothing hidden, interactive or outside <main>", async () => {
    await cmdOpen(ctx, `${base}/fixture.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      [
        "# Title",
        `Plain **bold** and *it* with \`x = 1\`, a [link](${base}/docs) and a jump.`,
        "- One\n- Two\n  - Inner",
        "1. First\n2. Second",
        "| Name | Qty |\n| --- | --- |\n| Apple | 2 |",
        "Layout cell",
        "```\nline 1\n  line 2\n```",
        "> Quoted",
        "---",
        `![Logo](${base}/a.png)`,
        "Email",
        "## Article",
        "Body text.",
      ].join("\n\n"),
    );
  }, 60_000);

  test("hidden text inside code, pre and a table stays out, and an all-hidden table converts to nothing", async () => {
    await cmdGoto(ctx, `${base}/hidden.html`);
    expect(await cmdMarkdown(ctx)).toBe("`shown`\n\n```\nab\n```\n\nafter");
  }, 60_000);

  test("emphasis keeps the spaces at its edges, a <br> in a cell keeps the row, and code fences outgrow the backticks inside", async () => {
    await cmdGoto(ctx, `${base}/edges.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      ["## Heading ref", "**bold** text and *it*alic", "| A | B |\n| --- | --- |\n| a b | c |", "``a`b``", "````\nbefore\n```\nafter\n````"].join("\n\n"),
    );
  }, 60_000);

  test("a ref to a heading keeps the heading's own Markdown", async () => {
    await cmdGoto(ctx, `${base}/edges.html`);
    await cmdSnapshot(ctx);
    expect(await cmdMarkdown(ctx, await refOfRole("heading"))).toBe("## Heading ref");
  }, 60_000);

  test("strikethrough, captions, visibility, details, escaping, sub/sup, code language, images, empty tables, pre-wrapped text, key-value rows", async () => {
    await cmdGoto(ctx, `${base}/fidelity.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      [
        "~~$99~~ ~~old~~ ~~gone~~ $49",
        "Prices",
        "| A |\n| --- |\n| 1 |",
        "shown child",
        "More",
        "Open",
        "open body",
        "\\# not a heading",
        "1\\. not a list",
        "\\- dash and \\<b>tag",
        "H<sub>2</sub>O x<sup>2</sup>",
        "```python3\nprint(1)\n```",
        "```js\nlet a\n```",
        `![A \\[b\\]](${base}/a.png) ![D]()`,
        "line one\nline two",
        "Developer: Apple",
        "Engine: WebKit",
      ].join("\n\n"),
    );
  }, 60_000);

  test("a closed details in a key cell, hidden images and rules, a list as a row's value, and parentheses in URLs", async () => {
    await cmdGoto(ctx, `${base}/review.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      ["Key more: v", "List:", "- A\n- B", "Lines: one two", `![pic](${base}/image%29a.png) [link](${base}/x%29y%28z.html)`].join("\n\n"),
    );
  }, 60_000);

  test("ET-45: a rowspan or colspan cell covers every row and column it spans", async () => {
    await cmdGoto(ctx, `${base}/spans.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      [
        "| Rank | Building | Country | Height | Height |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Shanghai Tower | China | 632 m | 2,073 ft |",
        "| 2 | Ping An | China | 599 m | 1,965 ft |",
        "",
        // Overlapping spans, an HTML table model error: the earlier cell keeps its slot.
        "| a | b | c |  |",
        "| --- | --- | --- | --- |",
        "| a | d | c | e |",
        "",
        "| f | g |",
        "| --- | --- |",
        "| f | h |",
        "",
        // A rowspan stops at the end of its row group, and a hidden row counts toward it.
        "| K | V |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "| p | q |",
        "| --- | --- |",
        "| s | t |",
      ].join("\n"),
    );
  }, 60_000);

  test("ET-46: a header row of th cells keeps a table with a block in a cell a table, and a block that is not printed does not count", async () => {
    await cmdGoto(ctx, `${base}/data.html`);
    expect(await cmdMarkdown(ctx)).toBe([`| Name | Image |\n| --- | --- |\n| Burj | ![pic](${base}/b.png) |`, "| a | b |\n| --- | --- |"].join("\n\n"));
  }, 60_000);

  test("ET-47, ET-48: block content inside an inline wrapper is separated, and a block link keeps its URL", async () => {
    await cmdGoto(ctx, `${base}/glued.html`);
    expect(await cmdMarkdown(ctx)).toBe(
      [`[Bloodlines What is it?](${base}/g)`, "1. If x, then\n   1. Let y.\n2. Return y.", `[Issues (3.6k)](${base}/issues)`, "**Warning**"].join("\n\n"),
    );
  }, 60_000);

  test("ET-49: GitHub's highlight-source- and MediaWiki's mw-highlight-lang- classes name the fence's language", async () => {
    await cmdGoto(ctx, `${base}/langs.html`);
    expect(await cmdMarkdown(ctx)).toBe("```shell\nbun add x\n```\n\n```python\nprint(2)\n```");
  }, 60_000);

  test("ET-62: an ordered list keeps its start, reversed order and li values", async () => {
    await cmdGoto(ctx, `${base}/lists.html`);
    expect(await cmdMarkdown(ctx)).toBe("5. five\n6. six\n\n2. a\n1. b\n\n10. ten\n11. eleven");
  }, 60_000);

  test("ET-61: with no budget, a rel=alternate link that never answers falls back to conversion after the alternate's own cap", async () => {
    const orig = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "0";
    try {
      await cmdGoto(ctx, `${base}/alt-slow.html`);
      const t0 = performance.now();
      expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
      expect(performance.now() - t0).toBeLessThan(10_000);
    } finally {
      if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = orig;
    }
  }, 60_000);

  test("--json carries the page's URL and title", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({
      url: `${base}/fixture.html`,
      title: "Markdown fixture",
    });
  }, 60_000);

  test("an empty result says so, with the page's title and URL", async () => {
    await cmdGoto(ctx, `${base}/blank.html`);
    expect(await cmdMarkdown(ctx)).toBe(`markdown: the page has no text ("Just a moment...", ${base}/blank.html)`);
    expect(JSON.parse(await cmdMarkdown(json))).toEqual({
      markdown: "",
      source: "converted",
      url: `${base}/blank.html`,
      title: "Just a moment...",
    });
  }, 60_000);

  test("without <main>, the whole body is converted", async () => {
    await cmdGoto(ctx, `${base}/no-main.html`);
    const md = await cmdMarkdown(ctx);
    expect(md.startsWith(`[Home](${base}/home) [About](${base}/about)\n\n# Title`)).toBe(true);
    expect(md.endsWith("Body text.\n\nFooter")).toBe(true);
  }, 60_000);

  test("--json names the source", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    const out = JSON.parse(await cmdMarkdown(json));
    expect(out.source).toBe("converted");
    expect(out.markdown.startsWith("# Title\n\n")).toBe(true);
  }, 60_000);

  test("--filename writes the Markdown and answers with the absolute path", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    const file = join(tmp, "page.md");
    expect(await cmdMarkdown(ctx, undefined, { filename: file })).toBe(`wrote ${file}`);
    expect(await readFile(file, "utf8")).toBe(`${await cmdMarkdown(ctx)}\n`);
    expect(JSON.parse(await cmdMarkdown(json, undefined, { filename: file }))).toEqual({
      ok: true,
      filename: file,
      source: "converted",
    });
  }, 60_000);

  test("a rel=alternate Markdown link is used as is", async () => {
    await cmdGoto(ctx, `${base}/alt.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "# From source\n\nText.", source: "page" });
  }, 60_000);

  test("a rel=alternate link that answers 404 falls back to conversion", async () => {
    await cmdGoto(ctx, `${base}/alt-missing.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
  }, 60_000);

  test("a rel=alternate link that has not answered by half the budget falls back to conversion", async () => {
    const orig = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "4000";
    try {
      await cmdGoto(ctx, `${base}/alt-slow.html`);
      const t0 = performance.now();
      expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
      expect(performance.now() - t0).toBeLessThan(4000);
    } finally {
      if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = orig;
    }
  }, 60_000);

  test("with no budget, a rel=alternate link gets 5 s before conversion (ET-61)", async () => {
    const orig = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "0";
    try {
      await cmdGoto(ctx, `${base}/alt-slow.html`);
      const t0 = performance.now();
      expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
      expect(performance.now() - t0).toBeLessThan(8000);
    } finally {
      if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = orig;
    }
  }, 60_000);

  test("a rel=alternate link that lands on an HTML page falls back to conversion", async () => {
    await cmdGoto(ctx, `${base}/alt-signin.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
    await cmdGoto(ctx, `${base}/alt-shell.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ markdown: "Rendered", source: "converted" });
  }, 60_000);

  test("a dialog the page opened is reported, under --json and in the text form", async () => {
    await cmdGoto(ctx, `${base}/alert.html`);
    await Bun.sleep(600);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({
      markdown: "Alert page",
      source: "converted",
      dialogs: [{ type: "alert", message: "hello", state: "dismissed" }],
    });
    await cmdGoto(ctx, `${base}/alert.html`);
    await Bun.sleep(600);
    expect(await cmdMarkdown(ctx)).toBe('Alert page\n### Modal state\n- ["alert" dialog with message "hello"]: dismissed');
  }, 60_000);

  test("a ref converts only its element", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    await cmdSnapshot(ctx);
    expect(await cmdMarkdown(ctx, await refOfRole("article"))).toBe("## Article\n\nBody text.");
  }, 60_000);

  test("a ref below the fold is read without scrolling the page", async () => {
    await cmdGoto(ctx, `${base}/tall.html`);
    await cmdSnapshot(ctx);
    expect(await cmdMarkdown(ctx, await refOfRole("article"))).toBe("Far below");
    expect(await cmdEval(ctx, "String(window.scrollY)")).toBe("0");
  }, 60_000);

  test("a ref from before a goto is refused", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    await cmdSnapshot(ctx);
    const ref = await refOfRole("article");
    await cmdGoto(ctx, `${base}/fixture.html`);
    await expect(cmdMarkdown(ctx, ref)).rejects.toThrow(`ref '${ref}' is from a page that is no longer loaded; take a new snapshot`);
  }, 60_000);
  describe("a YouTube video gives its transcript (#223)", () => {
    const watch = (kase?: string) => `${base}/watch?v=abc123def45${kase ? `&case=${kase}` : ""}`;
    const withBudget = async <T>(ms: string, run: () => Promise<T>): Promise<T> => {
      const orig = process.env.BOWSER_OP_TIMEOUT_MS;
      process.env.BOWSER_OP_TIMEOUT_MS = ms;
      try {
        return await run();
      } finally {
        if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
        else process.env.BOWSER_OP_TIMEOUT_MS = orig;
      }
    };
    const clicks = async () => JSON.parse(await cmdEval(ctx, "JSON.stringify(window.clicks)"));

    test("the transcript, in 30-second paragraphs with one-line segments", async () => {
      await cmdGoto(ctx, watch());
      expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({
        source: "transcript",
        markdown: "# Fixture video\nhttps://youtu.be/abc123def45 · English (auto-generated)\n\n[0:01] Hello there # boom\n\n[0:31] a - b",
      });
      expect(await clicks()).toEqual({ expand: 1, transcript: 1 });
    }, 60_000);

    test("no caption tracks: the page converted, at once", async () => {
      await cmdGoto(ctx, watch("notracks"));
      const t0 = performance.now();
      expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ source: "converted" });
      expect(performance.now() - t0).toBeLessThan(1000);
    }, 60_000);

    test("captions that never load: exit 2 within the budget's half", async () => {
      await cmdGoto(ctx, watch("never"));
      await withBudget("2000", async () => {
        await expect(cmdMarkdown(json)).rejects.toThrow(`markdown: the transcript of ${watch("never")} did not load within 1000ms`);
      });
    }, 60_000);

    test("budget 0: the wait still ends, at 5000ms", async () => {
      await cmdGoto(ctx, watch("never"));
      const t0 = performance.now();
      await withBudget("0", async () => {
        await expect(cmdMarkdown(json)).rejects.toThrow("did not load within 5000ms");
      });
      expect(performance.now() - t0).toBeLessThan(6000);
    }, 60_000);

    test("the previous video's segments under a hidden panel are not read", async () => {
      await cmdGoto(ctx, watch("stale"));
      const out = JSON.parse(await cmdMarkdown(json));
      expect(out.source).toBe("transcript");
      expect(out.markdown).toContain("[0:01] Hello there");
      expect(out.markdown).not.toContain("PREVIOUS VIDEO");
    }, 60_000);

    test("old segments that never leave: exit 2, and their text is nowhere", async () => {
      await cmdGoto(ctx, watch("stale-forever"));
      const err = await withBudget("2000", () => cmdMarkdown(json).catch((e: Error) => e));
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`markdown: the transcript of ${watch("stale-forever")} did not load within 1000ms`);
    }, 60_000);

    test("an expanded panel is read as is, without clicking", async () => {
      await cmdGoto(ctx, watch("expanded"));
      expect(JSON.parse(await cmdMarkdown(json)).markdown).toBe(
        "# Fixture video\nhttps://youtu.be/abc123def45 · English (auto-generated)\n\n[0:05] Already open",
      );
      expect(await clicks()).toEqual({ expand: 0, transcript: 0 });
    }, 60_000);

    test("a description already open is not clicked again", async () => {
      await cmdGoto(ctx, watch("desc-open"));
      expect(JSON.parse(await cmdMarkdown(json)).source).toBe("transcript");
      expect(await clicks()).toEqual({ expand: 0, transcript: 1 });
    }, 60_000);

    test("a timestamp lower than the paragraph start opens a new paragraph", async () => {
      await cmdGoto(ctx, watch("rewind"));
      expect(JSON.parse(await cmdMarkdown(json)).markdown).toBe(
        "# Fixture video\nhttps://youtu.be/abc123def45 · English (auto-generated)\n\n[0:01] one\n\n[0:40] two\n\n[0:10] three",
      );
    }, 60_000);

    test("a player that boots after load is waited for", async () => {
      await cmdGoto(ctx, watch("late-player"));
      expect(JSON.parse(await cmdMarkdown(json)).source).toBe("transcript");
    }, 60_000);
  });
});

runOrSkipNet("e2e: markdown on a claude.ai artifact", () => {
  const ctx: CommandContext = { session: "markdown-net", json: true };
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-markdown-net-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("the artifact's own Markdown comes back, not a conversion", async () => {
    await cmdOpen(ctx, "https://claude.ai/public/artifacts/d151f8dc-115f-4017-92f9-658407643389");
    const out = JSON.parse(await cmdMarkdown(ctx));
    expect(out.source).toBe("page");
    expect(out.markdown.startsWith("# Aqara W400")).toBe(true);
  }, 60_000);

  test("a YouTube video gives its transcript (#223)", async () => {
    await cmdOpen(ctx, "https://www.youtube.com/watch?v=4UtrRVtUN_g");
    const out = JSON.parse(await cmdMarkdown(ctx));
    expect(out.source).toBe("transcript");
    const lines = out.markdown.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "# How to Build an AI Code Review Agent - Daksh Gupta, Greptile",
      "https://youtu.be/4UtrRVtUN_g · English (auto-generated)",
    ]);
    const paras = lines.filter((l: string) => /^\[\d+:\d\d\] /.test(l));
    expect(paras.length).toBeGreaterThanOrEqual(30);
    const starts = paras.map((l: string) =>
      l
        .slice(1, l.indexOf("]"))
        .split(":")
        .reduce((a: number, v: string) => a * 60 + Number(v), 0),
    );
    expect(starts).toEqual([...starts].sort((a: number, b: number) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    expect(Math.max(...paras.map((l: string) => l.length))).toBeLessThan(3000);
  }, 60_000);
});
