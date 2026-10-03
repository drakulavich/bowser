// End-to-end on WebKit (#112): a ref whose click point another element
// covers is refused at once, naming what covers it. WebKit's selector click
// waits for its target to be the topmost element at its centre, so a click
// under a full-page backdrop waited out the budget; and a button the page
// swapped for another in the same place had the replacement pressed.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-covered.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdCheck, cmdClick, cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

/** ET-C1: a full-page backdrop over the page's controls. */
const BACKDROP = `<!doctype html><title>backdrop</title>
<button onclick="document.body.dataset.clicked = 'yes'">Add to cart</button>
<input aria-label="Search">
<div style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3); z-index: 10"></div>`;

/** ET-C4: "Add" puts a "+" button over itself and leaves the page 800 ms
 *  later. No ids, so once "Add" is gone "+" is the first button in the slot. */
const SWAP = `<!doctype html><title>swap</title>
<div id="slot" style="position: relative">
  <button style="width: 120px; height: 40px" onclick="add()">Add</button>
</div>
<script>
  window.adds = 0; window.plus = 0;
  function add() {
    adds++;
    const old = document.querySelector('#slot button');
    const p = document.createElement('button');
    p.textContent = '+';
    p.style = 'position: absolute; left: 0; top: 0; width: 120px; height: 40px';
    p.onclick = () => { plus++; };
    document.getElementById('slot').append(p);
    setTimeout(() => old.remove(), 800);
  }
</script>`;

/** A button under a fixed header once the page is scrolled to 280 px, on a
 *  page that scrolls smoothly: the scroll that clears it must be done
 *  before the hit test. */
const SMOOTH = `<!doctype html><title>smooth</title>
<style>html { scroll-behavior: smooth }</style>
<header style="position: fixed; top: 0; left: 0; right: 0; height: 120px; background: #ccc; z-index: 10">Header</header>
<div style="height: 300px"></div>
<button id="under" onclick="document.body.dataset.clicked = 'yes'">Under</button>
<div style="height: 3000px"></div>`;

/** A button below the fold; the page's first scroll puts a backdrop over
 *  everything, after the hit test and before the click. */
const LATE = `<!doctype html><title>late</title>
<div style="height: 2500px"></div>
<button onclick="document.body.dataset.clicked = 'yes'">Late</button>
<div style="height: 2500px"></div>
<script>
  addEventListener('scroll', () => {
    if (window.covered) return;
    window.covered = true;
    const d = document.createElement('div');
    d.style = 'position: fixed; inset: 0; z-index: 10';
    document.body.append(d);
  });
</script>`;

/** Targets whose click point is the target, a descendant, or nothing that
 *  takes pointer events: none of these may be refused. */
const HITTABLE = `<!doctype html><title>hittable</title>
<label><input type="checkbox" id="agree"> I agree</label>
<button onclick="document.body.dataset.nested = 'yes'"><span style="display: inline-block; padding: 20px 40px">Go <b>now</b></span></button>
<x-btn role="button" aria-label="Shadow host" style="display: inline-block" onclick="document.body.dataset.host = 'yes'"></x-btn>
<button onclick="document.body.dataset.icon = 'yes'"><x-icon style="display: inline-block"></x-icon>Icon</button>
<button id="ghost" onclick="document.body.dataset.ghost = 'yes'">Under glass</button>
<div style="position: fixed; inset: 0; pointer-events: none; background: rgba(0, 0, 0, 0.1)"></div>
<div style="width: 4000px; height: 2500px"></div>
<button style="margin-left: 1200px; width: 300px" onclick="document.body.dataset.wide = 'yes'">Wide</button>
<script>
  for (const tag of ['x-btn', 'x-icon']) {
    customElements.define(tag, class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<span style="display: inline-block; padding: 20px 40px">' + tag + '</span>';
      }
    });
  }
</script>`;

runOrSkip("e2e: a ref under another element (#112)", () => {
  const ctx: CommandContext = { session: `covered-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    tmp = await mkdtemp(join(tmpdir(), "bowser-covered-"));
    process.env.HOME = tmp;
    // The daemon inherits it: before #112 the backdrop click hung this long.
    process.env.BOWSER_OP_TIMEOUT_MS = "8000";
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response({ "/backdrop": BACKDROP, "/swap": SWAP, "/smooth": SMOOTH, "/late": LATE }[new URL(req.url).pathname] ?? HITTABLE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };
  const failure = (p: Promise<string>) => p.then(
    (out) => { throw new Error(`expected a failure, got: ${out}`); },
    (err: Error) => err,
  );

  test("click and fill under a full-page backdrop are refused at once, exit 1, and the session stays usable", async () => {
    await cmdOpen(ctx, `${base}/backdrop`);
    await cmdSnapshot(ctx);
    const button = await refNamed("Add to cart");
    const input = await refNamed("Search");

    let t0 = performance.now();
    const click = await failure(cmdClick(ctx, button));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(click.message).toBe(`ref '${button}' (button "Add to cart") is covered by generic <div> at its click point; take a new snapshot or close what covers it`);
    expect(reportFailure(click).code).toBe(1);

    t0 = performance.now();
    const fill = await failure(cmdFill(ctx, input, "milk"));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(fill.message).toBe(`ref '${input}' (textbox "Search") is covered by generic <div> at its click point; take a new snapshot or close what covers it`);

    expect(await cmdEval(ctx, "String(document.body.dataset.clicked)")).toBe("undefined");
    expect(await cmdEval(ctx, "document.querySelector('input').value")).toBe("");
    await cmdEval(ctx, "document.querySelector('div').remove()");
    await cmdClick(ctx, button);
    expect(await cmdEval(ctx, "document.body.dataset.clicked")).toBe("yes");
  }, 30_000);

  test("a second click on a button the page swapped for '+' is refused, and '+' is not pressed", async () => {
    await cmdOpen(ctx, `${base}/swap`);
    await cmdSnapshot(ctx);
    const add = await refNamed("Add");
    await cmdClick(ctx, add);
    const second = await failure(cmdClick(ctx, add));
    expect(second.message).toBe(`ref '${add}' (button "Add") is covered by button "+" at its click point; take a new snapshot or close what covers it`);
    expect(reportFailure(second).code).toBe(1);
    await Bun.sleep(1000);
    expect(await cmdEval(ctx, "JSON.stringify([window.adds, window.plus])")).toBe("[1,0]");
  }, 30_000);

  test("click on a button under a fixed header on a smooth-scrolling page scrolls it clear and clicks it", async () => {
    await cmdOpen(ctx, `${base}/smooth`);
    await cmdSnapshot(ctx);
    const button = await refNamed("Under");
    const top = Number(await cmdEval(ctx, "(scrollTo({ top: 280, behavior: 'instant' }), document.getElementById('under').getBoundingClientRect().top)"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(100);
    await cmdClick(ctx, button);
    expect(await cmdEval(ctx, "document.body.dataset.clicked")).toBe("yes");
  }, 30_000);

  test("a cover that appears after the hit test times the click out at the budget, and the session stays usable", async () => {
    await cmdOpen(ctx, `${base}/late`);
    await cmdSnapshot(ctx);
    const button = await refNamed("Late");
    process.env.BOWSER_OP_TIMEOUT_MS = "3000";
    let err: Error;
    const t0 = performance.now();
    try {
      err = await failure(cmdClick(ctx, button));
    } finally {
      process.env.BOWSER_OP_TIMEOUT_MS = "8000";
    }
    expect(performance.now() - t0).toBeLessThan(4000);
    // Bun's click was still waiting for the target to be actionable, which
    // the daemon cannot tell from a click it already fired (#115).
    expect(err.message).toBe("'click' timed out after 3000ms; the click may have been delivered, check the page before retrying");
    expect(reportFailure(err).code).toBe(2);
    expect(await cmdEval(ctx, "String(document.body.dataset.clicked) + ' ' + window.covered")).toBe("undefined true");
  }, 30_000);

  test("a target hit at itself, a descendant, its shadow content or through a pointer-events:none layer is clicked", async () => {
    await cmdOpen(ctx, `${base}/hittable`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("I agree"));
    expect(await cmdEval(ctx, "document.getElementById('agree').checked")).toBe("true");
    await cmdCheck(ctx, await refNamed("I agree"));
    expect(await cmdEval(ctx, "document.getElementById('agree').checked")).toBe("true");
    for (const [name, key] of [["Go now", "nested"], ["Shadow host", "host"], ["Icon", "icon"], ["Under glass", "ghost"], ["Wide", "wide"]]) {
      const t0 = performance.now();
      await cmdClick(ctx, await refNamed(name!));
      expect(performance.now() - t0).toBeLessThan(5000);
      expect(await cmdEval(ctx, `document.body.dataset.${key}`)).toBe("yes");
    }
  }, 60_000);
});
