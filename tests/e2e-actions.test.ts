// End-to-end on WebKit: `press Tab` moves focus instead of inserting a tab
// (spec 2026-09-27-p2-fixes-design.md, F11), and `click`/`check`/`uncheck`
// refuse a disabled control and `uncheck` a checked radio instead of
// reporting success and doing nothing (F20). Each check reads the page back
// with `eval`, including a log of every click and keydown the page saw.
// The second block (issue #51, items 7 and 11) checks that the URL bowser
// reports follows the page: after `history.pushState`, and after a `select`
// or `check` whose change handler navigates to a slow page.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-actions.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdCheck, cmdClick, cmdPress, cmdSelect, cmdUncheck } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: actions on WebKit", () => {
  const ctx: CommandContext = { session: `actions-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-actions-"));
    process.env.HOME = tmp;
    const page = await readFile(join(import.meta.dir, "fixtures/actions.html"), "utf8");
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  // A fresh page per test: focus, state and the log start clean.
  beforeEach(async () => {
    await cmdOpen(ctx, server!.url.toString());
    await cmdSnapshot(ctx);
  }, 30_000);

  async function ref(name: string): Promise<string> {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    return r.id;
  }
  const js = (expr: string) => cmdEval(ctx, `JSON.stringify(${expr})`);
  const log = () => js("window.log");
  const failure = (p: Promise<string>) => p.then(
    (out) => { throw new Error(`expected a failure, got: ${out}`); },
    (err: Error) => err,
  );
  /** Runs `p`, which must fail at once with `message` and exit 1. */
  async function refused(p: Promise<string>, message: string): Promise<void> {
    const started = Date.now();
    const err = await failure(p);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(err.message).toBe(message);
    expect(reportFailure(err).code).toBe(1);
  }

  describe("F11: press Tab", () => {
    test("from a text field focuses the next field and leaves the value empty", async () => {
      await cmdClick(ctx, await ref("A"));
      await cmdPress(ctx, "Tab");
      expect(await js("[document.activeElement.id, a.value, b.value]")).toBe(`["b","",""]`);
    });

    test("from <body> focuses the first focusable element", async () => {
      expect(await js("document.activeElement.tagName")).toBe(`"BODY"`);
      await cmdPress(ctx, "Tab");
      expect(await js("document.activeElement.id")).toBe(`"a"`);
    });

    test("a page keydown listener sees a trusted Tab", async () => {
      await cmdPress(ctx, "Tab");
      expect(await log()).toBe(`["keydown:Tab:true"]`);
    });

    test("other keys are unchanged: a letter lands in the field, Backspace removes it", async () => {
      await cmdClick(ctx, await ref("A"));
      await cmdPress(ctx, "x");
      expect(await js("a.value")).toBe(`"x"`);
      await cmdPress(ctx, "Backspace");
      expect(await js("[document.activeElement.id, a.value]")).toBe(`["a",""]`);
    });
  });

  describe("F20: disabled controls", () => {
    test("click on a disabled button: exit 1, no handler ran", async () => {
      const e = await ref("DisBtn");
      await refused(cmdClick(ctx, e), `ref '${e}' is disabled`);
      expect(await log()).toBe("[]");
    });

    for (const [name, id] of [["DisabledBox", "disbox"], ["FieldsetBox", "fsbox"]] as const) {
      test(`check on ${name}: exit 1, stays unchecked`, async () => {
        const e = await ref(name);
        await refused(cmdCheck(ctx, e), `ref '${e}' is disabled`);
        expect(await js(`${id}.checked`)).toBe("false");
        expect(await log()).toBe("[]");
      });
    }

    for (const [name, id] of [["AriaDis", "ariadis"], ["AriaInherit", "ariainner"]] as const) {
      test(`check on ${name} (aria-disabled): exit 1, no handler ran`, async () => {
        const e = await ref(name);
        await refused(cmdCheck(ctx, e), `ref '${e}' is disabled`);
        expect(await js(`${id}.getAttribute('aria-checked')`)).toBe(`"false"`);
        expect(await log()).toBe("[]");
      });
    }

    test("uncheck on a disabled checkbox: exit 1", async () => {
      const e = await ref("DisabledBox");
      await cmdEval(ctx, "(disbox.disabled = false, disbox.checked = true, disbox.disabled = true)");
      await refused(cmdUncheck(ctx, e), `ref '${e}' is disabled`);
      expect(await js("disbox.checked")).toBe("true");
    });

    test("disabled is read from the live element, not the saved ref", async () => {
      const e = await ref("OkBtn");
      await cmdEval(ctx, "okbtn.disabled = true");
      await refused(cmdClick(ctx, e), `ref '${e}' is disabled`);
      expect(await log()).toBe("[]");
    });

    test("an enabled button and checkbox still act", async () => {
      await cmdClick(ctx, await ref("OkBtn"));
      await cmdCheck(ctx, await ref("OkBox"));
      expect(await js("okbox.checked")).toBe("true");
      expect(await log()).toBe(`["click:okbtn","click:okbox"]`);
    });
  });

  test("check reads aria-checked on a role=checkbox: an already checked one is not clicked off", async () => {
    await cmdCheck(ctx, await ref("AriaOn"));
    expect(await js("ariaon.getAttribute('aria-checked')")).toBe(`"true"`);
    expect(await log()).toBe("[]");
  });

  // aria-checked="mixed" counts as on for uncheck, and as off for check, as
  // in playwright. The page's handler cycles mixed -> true -> false, like the
  // APG mixed checkbox, so uncheck clicks until it reads false.
  describe("aria-checked=mixed", () => {
    test("uncheck clicks it until it reads false", async () => {
      await cmdUncheck(ctx, await ref("AriaMixed"));
      expect(await js("ariamixed.getAttribute('aria-checked')")).toBe(`"false"`);
      expect(await log()).toBe(`["click:ariamixed","click:ariamixed"]`);
    });

    test("check clicks it once", async () => {
      await cmdCheck(ctx, await ref("AriaMixed"));
      expect(await js("ariamixed.getAttribute('aria-checked')")).toBe(`"true"`);
      expect(await log()).toBe(`["click:ariamixed"]`);
    });
  });

  describe("F20: uncheck on a radio", () => {
    test("a checked radio: exit 1, it stays checked", async () => {
      const e = await ref("Large");
      await refused(cmdUncheck(ctx, e), `ref '${e}' is a radio button; select another option in its group to uncheck it`);
      expect(await js("[large.checked, small.checked]")).toBe("[true,false]");
      expect(await log()).toBe("[]");
    });

    test("a checked role=radio: exit 1, no handler ran", async () => {
      const e = await ref("AriaRadio");
      await refused(cmdUncheck(ctx, e), `ref '${e}' is a radio button; select another option in its group to uncheck it`);
      expect(await log()).toBe("[]");
    });

    test("an unchecked radio: exit 0, nothing changes", async () => {
      const e = await ref("Small");
      expect(await cmdUncheck(ctx, e)).toBe(`unchecked ${e}`);
      expect(await js("[large.checked, small.checked]")).toBe("[true,false]");
      expect(await log()).toBe("[]");
    });
  });
});

runOrSkip("e2e: the reported URL follows the page (#51)", () => {
  const ctx: CommandContext = { session: `actions-nav-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-actions-nav-"));
    process.env.HOME = tmp;
    const page = await readFile(join(import.meta.dir, "fixtures/navigating-controls.html"), "utf8");
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        // Slow, as in the spec's measurement: the old page is still up when
        // the action returns unless bowser waits for the navigation.
        if (new URL(req.url).pathname === "/next") {
          await Bun.sleep(1500);
          return html("<!doctype html><title>Next</title><h1>Next</h1>");
        }
        return html(page);
      },
    });
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cmdOpen(ctx, new URL("/a", server!.url).toString());
    await cmdSnapshot(ctx);
  }, 30_000);

  async function ref(name: string): Promise<string> {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    return r.id;
  }
  const next = () => new URL("/next", server!.url).toString();

  test("click on a pushState button replies with the new URL, and state.json holds it", async () => {
    const pushed = new URL("/pushed?x=1", server!.url).toString();
    const out = await cmdClick({ ...ctx, json: true }, await ref("Push"));
    expect(JSON.parse(out).url).toBe(pushed);
    expect((await loadState(ctx.session))!.url).toBe(pushed);
    expect(await cmdSnapshot(ctx)).toContain(`- Page URL: ${pushed}\n`);
  });
});
