// End-to-end on WebKit (#270): what `hover` opens. Bun.WebView has no native
// pointer move, so hover dispatches the entry events from a page script; a
// CSS :hover rule never applies, and the answer says the page did not change.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test ./tests/e2e-hover.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdHover } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const MENUS = `<!doctype html><title>menus</title>
<style>.menu { display: none } #css:hover + .menu { display: block }</style>
<button id="css">CSS menu</button><div class="menu">css</div>
<button id="over" onmouseover="this.nextElementSibling.style.display = 'block'">Over menu</button><div class="menu">over</div>
<button id="enter">Enter menu</button><div class="menu">enter</div>
<x-menu role="button" aria-label="Shadow menu" style="display: inline-block"></x-menu>
<button id="intent">Intent menu</button><div class="menu">intent</div>
<script>
  document.getElementById('enter').addEventListener('mouseenter', (e) => { e.currentTarget.nextElementSibling.style.display = 'block'; });
  document.getElementById('intent').addEventListener('mouseenter', (e) => { const m = e.currentTarget.nextElementSibling; setTimeout(() => { m.style.display = 'block'; }, 150); });
  customElements.define('x-menu', class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<span>Shadow</span><b></b>';
      this.addEventListener('mouseenter', () => { root.querySelector('b').textContent = 'open'; });
    }
  });
</script>`;

const LOGGER = `<!doctype html><title>logger</title>
<div id="parent"><button id="logger">Log</button></div>
<script>
  window.log = [];
  const t = document.getElementById('logger'), p = document.getElementById('parent');
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) t.addEventListener(type, () => log.push(type));
  for (const type of ['pointerenter', 'mouseenter']) p.addEventListener(type, () => log.push(type + ' (parent)'));
</script>`;

const NO_CHANGE = "; the page did not change within 200 ms (bowser cannot trigger CSS :hover)";

runOrSkip("e2e: hover sends the entry events and says when the page did not change (#270)", () => {
  const ctx: CommandContext = { session: `hover-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-hover-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(new URL(req.url).pathname === "/logger" ? LOGGER : MENUS, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };

  test("the mouseover, mouseenter, shadow and hover-intent menus open; the CSS menu does not, and says so", async () => {
    await cmdOpen(ctx, `${base}/menus`);
    await cmdSnapshot(ctx);
    // The hover-intent menu goes last: its timer must not land in another hover's watch.
    const answers: string[] = [];
    for (const name of ["CSS menu", "Over menu", "Enter menu", "Shadow menu", "Intent menu"]) {
      const ref = await refNamed(name);
      answers.push((await cmdHover(ctx, ref)).replace(ref, "eN"));
    }
    expect(answers).toEqual([`hovered eN${NO_CHANGE}`, "hovered eN", "hovered eN", "hovered eN", "hovered eN"]);
    const open = await cmdEval(
      ctx,
      "JSON.stringify([...['css', 'over', 'enter', 'intent'].map((id) => getComputedStyle(document.getElementById(id).nextElementSibling).display), document.querySelector('x-menu').shadowRoot.querySelector('b').textContent])",
    );
    expect(open).toBe('["none","block","block","block","open"]');

    const json = { ...ctx, json: true };
    expect(JSON.parse(await cmdHover(json, await refNamed("CSS menu"))).changed).toBe(false);
    await cmdEval(ctx, "document.getElementById('over').nextElementSibling.style.display = 'none'");
    expect(JSON.parse(await cmdHover(json, await refNamed("Over menu"))).changed).toBe(true);
  }, 30_000);

  test("one hover sends the entry events in a browser's order, the enter events to the parent too", async () => {
    await cmdOpen(ctx, `${base}/logger`);
    await cmdSnapshot(ctx);
    await cmdHover(ctx, await refNamed("Log"));
    expect(await cmdEval(ctx, "log.join(', ')")).toBe(
      "pointerover, pointerenter (parent), pointerenter, mouseover, mouseenter (parent), mouseenter, pointermove, mousemove",
    );
  }, 30_000);
});
