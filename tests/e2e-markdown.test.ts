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
const EDGES = "<!doctype html><title>edges</title><main><h2>Heading ref</h2><p><strong>bold </strong>text and <em> it</em>alic</p><table><tr><th>A</th><th>B</th></tr><tr><td>a<br>b</td><td>c</td></tr></table><p><code>a`b</code></p><pre>before\n```\nafter</pre></main>";
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
        if (path === "/blank.html") return html("<!doctype html><title>Just a moment...</title><main></main>");
        if (path === "/alt-slow.html") return html(ALT("/slow.md"));
        if (path === "/slow.md") { await Bun.sleep(20_000); return new Response("# Late"); }
        if (path === "/alt-signin.html") return html(ALT("/private.md"));
        if (path === "/private.md") return Response.redirect("/signin.html", 302);
        if (path === "/signin.html") return html("<!doctype html><title>Sign in</title><form>Sign in</form>");
        if (path === "/alt-shell.html") return html(ALT("/shell.md"));
        if (path === "/shell.md") return html("<!doctype html><div id=root>Loading</div>");
        if (path === "/alert.html") return html("<!doctype html><title>alert</title><main><p>Alert page</p></main><script>setTimeout(() => alert('hello'), 300)</script>");
        if (path === "/page.md") return new Response("# From source\n\nText.\n", { headers: { "content-type": "text/markdown" } });
        return new Response("not found", { status: 404 });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
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
    expect(await cmdMarkdown(ctx)).toBe([
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
    ].join("\n\n"));
  }, 60_000);

  test("hidden text inside code, pre and a table stays out, and an all-hidden table converts to nothing", async () => {
    await cmdGoto(ctx, `${base}/hidden.html`);
    expect(await cmdMarkdown(ctx)).toBe("`shown`\n\n```\nab\n```\n\nafter");
  }, 60_000);

  test("emphasis keeps the spaces at its edges, a <br> in a cell keeps the row, and code fences outgrow the backticks inside", async () => {
    await cmdGoto(ctx, `${base}/edges.html`);
    expect(await cmdMarkdown(ctx)).toBe([
      "## Heading ref",
      "**bold** text and *it*alic",
      "| A | B |\n| --- | --- |\n| a b | c |",
      "``a`b``",
      "````\nbefore\n```\nafter\n````",
    ].join("\n\n"));
  }, 60_000);

  test("a ref to a heading keeps the heading's own Markdown", async () => {
    await cmdGoto(ctx, `${base}/edges.html`);
    await cmdSnapshot(ctx);
    expect(await cmdMarkdown(ctx, await refOfRole("heading"))).toBe("## Heading ref");
  }, 60_000);

  test("strikethrough, captions, visibility, details, escaping, sub/sup, code language, images, empty tables, pre-wrapped text, key-value rows", async () => {
    await cmdGoto(ctx, `${base}/fidelity.html`);
    expect(await cmdMarkdown(ctx)).toBe([
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
    ].join("\n\n"));
  }, 60_000);

  test("a closed details in a key cell, hidden images and rules, a list as a row's value, and parentheses in URLs", async () => {
    await cmdGoto(ctx, `${base}/review.html`);
    expect(await cmdMarkdown(ctx)).toBe([
      "Key more: v",
      "List:",
      "- A\n- B",
      "Lines: one two",
      `![pic](${base}/image%29a.png) [link](${base}/x%29y%28z.html)`,
    ].join("\n\n"));
  }, 60_000);

  test("--json carries the page's URL and title", async () => {
    await cmdGoto(ctx, `${base}/fixture.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toMatchObject({ url: `${base}/fixture.html`, title: "Markdown fixture" });
  }, 60_000);

  test("an empty result says so, with the page's title and URL", async () => {
    await cmdGoto(ctx, `${base}/blank.html`);
    expect(await cmdMarkdown(ctx)).toBe(`markdown: the page has no text ("Just a moment...", ${base}/blank.html)`);
    expect(JSON.parse(await cmdMarkdown(json))).toEqual({ markdown: "", source: "converted", url: `${base}/blank.html`, title: "Just a moment..." });
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
    expect(JSON.parse(await cmdMarkdown(json, undefined, { filename: file }))).toEqual({ ok: true, filename: file, source: "converted" });
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
      if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS; else process.env.BOWSER_OP_TIMEOUT_MS = orig;
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
      markdown: "Alert page", source: "converted", dialogs: [{ type: "alert", message: "hello", state: "dismissed" }],
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
    try { await cmdClose(ctx); } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("the artifact's own Markdown comes back, not a conversion", async () => {
    await cmdOpen(ctx, "https://claude.ai/public/artifacts/d151f8dc-115f-4017-92f9-658407643389");
    const out = JSON.parse(await cmdMarkdown(ctx));
    expect(out.source).toBe("page");
    expect(out.markdown.startsWith("# Aqara W400")).toBe(true);
  }, 60_000);
});
