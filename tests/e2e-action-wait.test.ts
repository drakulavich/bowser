// End-to-end on WebKit (#270): hover, check, uncheck and select wait for
// their target as click does, within the budget, and send nothing when the
// wait runs out. Before #270 they acted at once on a hidden or moving target.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-action-wait.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdCheck, cmdClick, cmdHover, cmdSelect, cmdUncheck } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

/** `move(ms)` moves the button every frame for `ms`, or for ever without it. */
const MOVER = `<!doctype html><title>mover</title>
<button id="mover" style="position: absolute; left: 0; top: 50px; width: 120px; height: 40px" onmouseenter="document.body.dataset.hovered = 'yes'">Mover</button>
<script>
  window.move = (ms) => {
    const until = ms == null ? Infinity : performance.now() + ms;
    const b = document.getElementById('mover');
    let x = 0;
    const tick = () => {
      if (performance.now() >= until) return;
      x = (x + 1) % 200;
      b.style.left = x + 'px';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
</script>`;

/** `hide(id, ms)` hides an element with visibility: hidden, and shows it again after `ms` if given. */
const HIDE = String.raw`<script>
  window.hide = (id, ms, then) => {
    const el = document.getElementById(id);
    el.style.visibility = 'hidden';
    if (ms != null) setTimeout(() => { el.style.visibility = ''; then?.(); }, ms);
  };
  window.changes = {};
</script>`;

const FORM = `<!doctype html><title>form</title>
<label><input type="checkbox" id="alpha"> Alpha</label>
<label><input type="checkbox" id="beta" checked> Beta</label>
<label><input type="checkbox" id="gamma"> Gamma</label>
<label><input type="checkbox" id="delta" checked> Delta</label>
<select id="late" aria-label="Late" onchange="changes[this.id] = (changes[this.id] || 0) + 1"><option>red</option><option>blue</option></select>
<select id="never" aria-label="Never" onchange="changes[this.id] = (changes[this.id] || 0) + 1"><option>red</option><option>blue</option></select>
<select id="off" aria-label="Off" disabled onchange="changes[this.id] = (changes[this.id] || 0) + 1"><option>red</option><option>blue</option></select>
<button id="ghost" style="position: relative; width: 120px; height: 40px" onclick="document.body.dataset.clicked = 'yes'"><span style="visibility: visible; position: absolute; left: 0; top: 0; width: 120px; height: 40px">Ghost</span></button>
<details open id="more"><summary>More</summary><label><input type="checkbox" id="inner"> Inner</label></details>
<div style="height: 3000px"></div>
<label><input type="checkbox" id="far"> Far</label>
<div style="height: 3000px"></div>
${HIDE}`;

runOrSkip("e2e: actions wait for their target (#270)", () => {
  const ctx: CommandContext = { session: `action-wait-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    tmp = await mkdtemp(join(tmpdir(), "bowser-action-wait-"));
    process.env.HOME = tmp;
    process.env.BOWSER_OP_TIMEOUT_MS = "8000";
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response(new URL(req.url).pathname === "/mover" ? MOVER : FORM, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
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
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };
  /** The error `p` fails with, its request given a 3000 ms budget. */
  const timedOut = async (p: () => Promise<string>): Promise<Error> => {
    process.env.BOWSER_OP_TIMEOUT_MS = "3000";
    try {
      return await p().then(
        (out) => {
          throw new Error(`expected a failure, got: ${out}`);
        },
        (err: Error) => err,
      );
    } finally {
      process.env.BOWSER_OP_TIMEOUT_MS = "8000";
    }
  };
  const evalText = (expr: string) => cmdEval(ctx, expr);

  test("hover waits for a moving button to stop, then hovers it", async () => {
    await cmdOpen(ctx, `${base}/mover`);
    await cmdSnapshot(ctx);
    const mover = await refNamed("Mover");
    const t0 = performance.now();
    await evalText("(move(600), 1)");
    expect(await cmdHover(ctx, mover)).toBe(`hovered ${mover}`);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(600);
    expect(await evalText("String(document.body.dataset.hovered)")).toBe("yes");
  }, 30_000);

  test("hover on a button that never stops fails at the budget, exit 2, and sends no events", async () => {
    await cmdOpen(ctx, `${base}/mover`);
    await cmdSnapshot(ctx);
    const mover = await refNamed("Mover");
    await evalText("(move(), 1)");
    const t0 = performance.now();
    const err = await timedOut(() => cmdHover(ctx, mover));
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(err.message).toBe("'hover' timed out after 3000ms");
    expect(reportFailure(err).code).toBe(2);
    expect(await evalText("String(document.body.dataset.hovered)")).toBe("undefined");
  }, 30_000);

  for (const [name, id, run, after] of [
    ["Alpha", "alpha", cmdCheck, "true"],
    ["Beta", "beta", cmdUncheck, "false"],
  ] as const) {
    test(`${run === cmdCheck ? "check" : "uncheck"} waits for a hidden checkbox to be shown, then acts`, async () => {
      await cmdOpen(ctx, `${base}/form`);
      await cmdSnapshot(ctx);
      const ref = await refNamed(name);
      const t0 = performance.now();
      await evalText(`(hide('${id}', 500), 1)`);
      await run(ctx, ref);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(500);
      expect(await evalText(`String(document.getElementById('${id}').checked)`)).toBe(after);
    }, 30_000);
  }

  test("check and uncheck on a checkbox that stays hidden fail at the budget, exit 2, state unchanged", async () => {
    await cmdOpen(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const gamma = await refNamed("Gamma");
    const delta = await refNamed("Delta");
    await evalText("(hide('gamma'), hide('delta'), 1)");
    const check = await timedOut(() => cmdCheck(ctx, gamma));
    expect(check.message).toBe("'check' timed out after 3000ms");
    expect(reportFailure(check).code).toBe(2);
    const uncheck = await timedOut(() => cmdUncheck(ctx, delta));
    expect(uncheck.message).toBe("'uncheck' timed out after 3000ms");
    expect(reportFailure(uncheck).code).toBe(2);
    expect(await evalText("[gamma.checked, delta.checked].join(' ')")).toBe("false true");
  }, 30_000);

  test("select waits for a hidden select to be shown, fails at the budget on one that stays hidden, and refuses a disabled one at once", async () => {
    await cmdOpen(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const late = await refNamed("Late");
    const never = await refNamed("Never");
    const off = await refNamed("Off");

    let t0 = performance.now();
    await evalText("(hide('late', 500), hide('never'), 1)");
    await cmdSelect(ctx, late, "blue");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(500);
    expect(await evalText("late.value + ' ' + changes.late")).toBe("blue 1");

    const err = await timedOut(() => cmdSelect(ctx, never, "blue"));
    expect(err.message).toBe("'select' timed out after 3000ms");
    expect(reportFailure(err).code).toBe(2);
    expect(await evalText("never.value + ' ' + changes.never")).toBe("red undefined");

    t0 = performance.now();
    const disabled = await timedOut(() => cmdSelect(ctx, off, "blue"));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(disabled.message).toBe(`ref '${off}' is disabled`);
    expect(reportFailure(disabled).code).toBe(1);
    expect(await evalText("off.value + ' ' + changes.off")).toBe("red undefined");
  }, 30_000);

  test("click on a visibility: hidden button whose visible child covers its centre fails at the budget, and its handler does not run", async () => {
    await cmdOpen(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const ghost = await refNamed("Ghost");
    await evalText("(ghost.style.visibility = 'hidden', 1)");
    const err = await timedOut(() => cmdClick(ctx, ghost));
    expect(err.message).toBe("'click' timed out after 3000ms");
    expect(reportFailure(err).code).toBe(2);
    expect(await evalText("String(document.body.dataset.clicked)")).toBe("undefined");
  }, 30_000);

  test("check waits out a checkbox inside a closed <details>, whose box is not empty", async () => {
    await cmdOpen(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const inner = await refNamed("Inner");
    await evalText("(more.open = false, 1)");
    expect(await evalText("String(inner.getBoundingClientRect().width > 0 && !inner.checkVisibility())")).toBe("true");
    const err = await timedOut(() => cmdCheck(ctx, inner));
    expect(err.message).toBe("'check' timed out after 3000ms");
    expect(await evalText("String(inner.checked)")).toBe("false");
  }, 30_000);

  test("check acts on a visible checkbox whose centre is outside the viewport", async () => {
    await cmdOpen(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const far = await refNamed("Far");
    // Shown 500 ms later, after the resolve has scrolled to it, while the page scrolls back to the top.
    await evalText("(hide('far', 500, () => scrollTo(0, 0)), 1)");
    await cmdCheck(ctx, far);
    expect(await evalText("String(far.checked) + ' ' + (far.getBoundingClientRect().top > innerHeight)")).toBe("true true");
  }, 30_000);
});
