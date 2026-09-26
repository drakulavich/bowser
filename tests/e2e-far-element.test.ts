// End-to-end: click and fill reach an element below the fold. WebKit's native
// click waits for its target to be in the viewport, so a link 2500 px down
// timed out after 30 s. The ref-resolve script now scrolls the element into
// view. Spec F8: docs/superpowers/specs/2026-09-26-p0-hangs-design.md.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-far-element.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick, cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

const LONG = `<!doctype html><title>long</title>
<h1>Top</h1>
<div style="height: 2500px">spacer</div>
<input id="low" aria-label="Low">
<a id="far" href="#" onclick="document.body.dataset.clicked = 'yes'; return false">FarLink</a>`;

/** A button that sits in the viewport but under a fixed header once the
 *  page is scrolled to 280 px: the header covers its centre point. */
const COVERED = `<!doctype html><title>covered</title>
<header style="position: fixed; top: 0; left: 0; right: 0; height: 120px; background: #ccc; z-index: 10"
  onclick="document.body.dataset.header = 'hit'">Header</header>
<div style="height: 300px"></div>
<button id="under" onclick="document.body.dataset.clicked = 'yes'">Under</button>
<div style="height: 3000px"></div>`;

runOrSkip("e2e: click and fill reach an element below the fold", () => {
  const ctx: CommandContext = { session: "farelement", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    tmp = await mkdtemp(join(tmpdir(), "bowser-far-"));
    process.env.HOME = tmp;
    // The daemon inherits it: a click that cannot reach its target fails in
    // 8 s instead of 30, which the 5 s assertions below still catch.
    process.env.BOWSER_OP_TIMEOUT_MS = "8000";
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(new URL(req.url).pathname === "/covered" ? COVERED : LONG, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };

  test("click on a link 2500 px down clicks it in under 5 s", async () => {
    await cmdOpen(ctx, `${base}/long`);
    await cmdSnapshot(ctx);
    const link = await refNamed("FarLink");
    const t0 = performance.now();
    await cmdClick(ctx, link);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(await cmdEval(ctx, "document.body.dataset.clicked")).toBe("yes");
  }, 30_000);

  test("fill on an input 2500 px down fills it in under 5 s", async () => {
    await cmdOpen(ctx, `${base}/long`);
    await cmdSnapshot(ctx);
    const input = await refNamed("Low");
    const t0 = performance.now();
    await cmdFill(ctx, input, "hi");
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(await cmdEval(ctx, "document.getElementById('low').value")).toBe("hi");
  }, 30_000);

  test("click on a button under a fixed header scrolls it clear and clicks it", async () => {
    await cmdOpen(ctx, `${base}/covered`);
    await cmdSnapshot(ctx);
    const button = await refNamed("Under");
    // In the viewport, under the 120 px header: the viewport test alone would not scroll.
    const top = Number(await cmdEval(ctx, "(window.scrollTo(0, 280), document.getElementById('under').getBoundingClientRect().top)"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(100);
    const t0 = performance.now();
    await cmdClick(ctx, button);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(await cmdEval(ctx, "document.body.dataset.clicked")).toBe("yes");
    expect(await cmdEval(ctx, "String(document.body.dataset.header)")).toBe("undefined");
  }, 30_000);
});
