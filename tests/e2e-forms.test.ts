// End-to-end on WebKit: `select` and `fill` on the form controls where they
// used to report success and do nothing or damage the value (spec
// 2026-09-27-p1-fixes-design.md, F12, F13, F14). Each check reads the value
// and the page's event log back with `eval`.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-forms.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdFill, cmdSelect } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: forms on WebKit", () => {
  const ctx: CommandContext = { session: `forms-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-forms-"));
    process.env.HOME = tmp;
    const page = await readFile(join(import.meta.dir, "fixtures/forms.html"), "utf8");
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

  // A fresh page per test: values and the event log start clean.
  beforeEach(async () => {
    await cmdOpen(ctx, server!.url.toString());
    await cmdSnapshot(ctx);
  }, 30_000);

  async function ref(name: string): Promise<string> {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    return r.id;
  }
  const value = (id: string) => cmdEval(ctx, `document.getElementById(${JSON.stringify(id)}).value`);
  const log = () => cmdEval(ctx, "JSON.stringify(window.log)");
  const failure = (p: Promise<string>) => p.then(
    (out) => { throw new Error(`expected a failure, got: ${out}`); },
    (err: Error) => err,
  );

  describe("F12: select", () => {
    test("by value", async () => {
      await cmdSelect(ctx, await ref("Color"), "g");
      expect(await value("color")).toBe("g");
    });

    test("by label", async () => {
      const e = await ref("Color");
      expect(await cmdSelect(ctx, e, "Red")).toBe(`selected ${e} -> "Red"`);
      expect(await value("color")).toBe("r");
    });

    test("the first option in document order whose value or label matches", async () => {
      // "Blue" is option b's label and option Navy's value; b comes first.
      await cmdSelect(ctx, await ref("Color"), "Blue");
      expect(await value("color")).toBe("b");
    });

    test("no matching option: exit 1 at once, value kept, no event", async () => {
      const e = await ref("Color");
      await cmdSelect(ctx, e, "g");
      await cmdEval(ctx, "window.log = []");
      const started = Date.now();
      const err = await failure(cmdSelect(ctx, e, "nosuch"));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(err.message).toBe(`ref '${e}' has no option "nosuch"`);
      expect(reportFailure(err).code).toBe(1);
      expect(await value("color")).toBe("g");
      expect(await log()).toBe("[]");
    });
  });

  describe("F13: fill refuses an element that cannot be edited", () => {
    for (const [name, id, why] of [
      ["Read only", "ro", "readonly"],
      ["Disabled", "dis", "disabled"],
      ["In fieldset", "fs", "disabled"],
      ["Read only notes", "rota", "readonly"],
    ] as const) {
      test(`${id}: exit 1, value kept, no event`, async () => {
        const e = await ref(name);
        const before = await value(id);
        const err = await failure(cmdFill(ctx, e, "x"));
        expect(err.message).toBe(`ref '${e}' is not an editable element (${why})`);
        expect(reportFailure(err).code).toBe(1);
        expect(await value(id)).toBe(before);
        expect(await log()).toBe("[]");
      });
    }

    test("an editable input still fills", async () => {
      await cmdFill(ctx, await ref("Name"), "hello");
      expect(await value("name")).toBe("hello");
    });
  });

  describe("F14: fill on date-like and number inputs", () => {
    test("a date is set in the page, with input and change", async () => {
      await cmdFill(ctx, await ref("Date"), "2024-01-02");
      expect(await value("d")).toBe("2024-01-02");
      expect(await log()).toBe(JSON.stringify(["input:d", "change:d"]));
    });

    test("time and color are set too", async () => {
      await cmdFill(ctx, await ref("Time"), "13:45");
      expect(await value("t")).toBe("13:45");
      await cmdFill(ctx, await ref("Colour"), "#00ff00");
      expect(await value("c")).toBe("#00ff00");
    });

    test("a date the input does not keep: exit 1, value kept, text not echoed", async () => {
      const e = await ref("Date");
      await cmdFill(ctx, e, "2024-01-02");
      await cmdEval(ctx, "window.log = []");
      const err = await failure(cmdFill(ctx, e, "tomorrow"));
      expect(err.message).toBe(`ref '${e}' did not accept the value for input[type=date]`);
      expect(reportFailure(err).code).toBe(1);
      expect(await value("d")).toBe("2024-01-02");
      expect(await log()).toBe("[]");
    });

    test("text on a number input: exit 1, value kept, text not echoed", async () => {
      const e = await ref("Quantity");
      await cmdFill(ctx, e, "42");
      expect(await value("n")).toBe("42");
      const err = await failure(cmdFill(ctx, e, "abc"));
      expect(err.message).toBe(`ref '${e}' needs a number (input[type=number])`);
      expect(err.message).not.toContain("abc");
      expect(reportFailure(err).code).toBe(1);
      expect(await value("n")).toBe("42");
    });
  });
});
