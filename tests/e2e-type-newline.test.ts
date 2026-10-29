// End-to-end: a newline in `type` text on a contenteditable editor starts a
// new paragraph, as pressing Enter would, and an <input> in a form still gets
// a space and no submit (#243).
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-type-newline.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick, cmdType } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

/** An editor that keeps paragraphs in its own model, as Lexical 0.53.0 does:
 *  it handles every beforeinput itself, and a "\n" inside inserted text is
 *  lost; only insertParagraph (Enter) starts a new paragraph. */
const EDITOR_HTML = `<!doctype html>
<html><head><title>Editor</title></head>
<body><div id="ed" contenteditable="true" role="textbox" aria-label="Editor"></div>
<script>
  const ed = document.getElementById("ed");
  window.paras = ["start"];
  const render = () => { ed.innerHTML = window.paras.map((p) => "<p>" + p + "</p>").join(""); };
  ed.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    if (e.inputType === "insertText") window.paras[window.paras.length - 1] += e.data.replaceAll("\\n", "");
    if (e.inputType === "insertParagraph") window.paras.push("");
    render();
  });
  render();
</script></body></html>`;

/** An editor whose Enter handler moves focus to the input next to it. */
const FOCUS_MOVE_HTML = `<!doctype html>
<html><head><title>Focus move</title></head>
<body><div id="ed" contenteditable="true" role="textbox" aria-label="Mover"></div>
<label>Next <input id="next"></label>
<script>
  document.getElementById("ed").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("next").focus(); }
  });
</script></body></html>`;

const FORM_HTML = `<!doctype html>
<html><head><title>Form</title></head>
<body><form onsubmit="event.preventDefault(); window.submits = (window.submits || 0) + 1">
<label>Line <input id="line"></label><button>Send</button></form>
<script>window.submits = 0;</script></body></html>`;

runOrSkip("e2e: type with a newline", () => {
  const ctx: CommandContext = { session: "typenewline", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-typenewline-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response({ "/form.html": FORM_HTML, "/focus-move.html": FOCUS_MOVE_HTML }[new URL(req.url).pathname] ?? EDITOR_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    base = server.url.toString().replace(/\/$/, "");
    await cmdOpen(ctx, `${base}/editor.html`);
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };

  test("a contenteditable editor gets a new paragraph for the newline", async () => {
    await cmdGoto(ctx, `${base}/editor.html`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("Editor"));
    expect(await cmdType(ctx, "first\nsecond")).toContain("typed 12 characters");
    expect(await cmdEval(ctx, "JSON.stringify(window.paras)")).toBe('["startfirst","second"]');
  }, 60_000);

  test("a CRLF counts as one newline", async () => {
    await cmdGoto(ctx, `${base}/editor.html`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("Editor"));
    await cmdType(ctx, "first\r\nsecond");
    expect(await cmdEval(ctx, "JSON.stringify(window.paras)")).toBe('["startfirst","second"]');
  }, 60_000);

  test("type stops when Enter moves focus out of the editor", async () => {
    await cmdGoto(ctx, `${base}/focus-move.html`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("Mover"));
    await expect(cmdType(ctx, "first\nsecond")).rejects.toThrow("type: focus left the editor after line 1 of 2; the rest was not typed");
    expect(await cmdEval(ctx, "JSON.stringify([document.getElementById('ed').textContent, document.getElementById('next').value])")).toBe('["first",""]');
  }, 60_000);

  test("an <input> in a form gets a space and the form is not submitted", async () => {
    await cmdGoto(ctx, `${base}/form.html`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("Line"));
    await cmdType(ctx, "first\nsecond");
    expect(await cmdEval(ctx, "JSON.stringify([document.getElementById('line').value, window.submits])")).toBe('["first second",0]');
  }, 60_000);
});
