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
      "![Logo]",
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
    expect(JSON.parse(await cmdMarkdown(json))).toEqual({ markdown: "# From source\n\nText.", source: "page" });
  }, 60_000);

  test("a rel=alternate link that answers 404 falls back to conversion", async () => {
    await cmdGoto(ctx, `${base}/alt-missing.html`);
    expect(JSON.parse(await cmdMarkdown(json))).toEqual({ markdown: "Rendered", source: "converted" });
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
