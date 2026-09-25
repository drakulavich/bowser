// End-to-end: an action on a ref from an old snapshot fails at once, the way
// playwright-cli's does, instead of waiting out the op timeout or acting on
// whatever element the saved selector now matches. Spec:
// docs/superpowers/specs/2026-09-26-stale-ref-design.md.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-stale-ref.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import {
  cmdCheck, cmdClick, cmdFill, cmdHover, cmdSelect, cmdUncheck,
} from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;
const FIXTURES = join(import.meta.dir, "fixtures");

const stale = (ref: string) => `ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`;

/** The tree text inside the ```yaml fence of `snapshot`'s output. */
function tree(out: string): string {
  const m = out.match(/\n```yaml\n([\s\S]*)\n```$/);
  if (!m) throw new Error(`no yaml fence in snapshot output:\n${out}`);
  return m[1]!;
}

runOrSkip("e2e: a stale ref fails at once (backend from resolveBackend)", () => {
  const ctx: CommandContext = { session: "staleref", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-staleref-"));
    process.env.HOME = tmp;
    if (resolveBackend().kind === "chrome" && !detectChromium()) {
      throw new Error("BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found.");
    }
    const pages: Record<string, string> = {
      "/todo-app.html": "todo-app.html",
      "/kitchen-sink.html": "kitchen-sink.html",
    };
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const file = pages[new URL(req.url).pathname];
        if (!file) return new Response("not found", { status: 404 });
        return new Response(Bun.file(join(FIXTURES, file)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
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

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };

  const addTodo = async (text: string) => {
    await cmdSnapshot(ctx);
    await cmdFill(ctx, await refNamed("New todo"), text);
    await cmdClick(ctx, await refNamed("Add"));
  };

  const checked = async (label: string): Promise<string> =>
    cmdEval(ctx, `String(document.querySelector('[aria-label="${label}"]').checked)`);

  test("ET-03: clicking a removed todo's checkbox fails in under 1 s and changes nothing", async () => {
    await cmdOpen(ctx, `${base}/todo-app.html`);
    await addTodo("alpha");
    await cmdSnapshot(ctx);
    await cmdCheck(ctx, await refNamed("Toggle alpha"));
    // Checking re-renders the list, so take the checkbox ref from a snapshot
    // of the checked todo, and "Clear completed" from the same one.
    await cmdSnapshot(ctx);
    const toggle = await refNamed("Toggle alpha");
    await cmdClick(ctx, await refNamed("Clear completed"));
    const body = "document.body.innerHTML";
    const before = await cmdEval(ctx, body);
    // No new snapshot: the checkbox ref is still in state.json, its element is gone.
    const t0 = performance.now();
    await expect(cmdClick(ctx, toggle)).rejects.toThrow(stale(toggle));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(await cmdEval(ctx, body)).toBe(before);
    const after = tree(await cmdSnapshot(ctx));
    expect(after).toContain("No todos yet");
    expect(after).toContain("0 items left");
  }, 60_000);

  test("wrong target: a removed todo's ref does not toggle the todo that moved into its place", async () => {
    await cmdOpen(ctx, `${base}/todo-app.html`);
    await addTodo("alpha");
    await addTodo("beta");
    await cmdSnapshot(ctx);
    const alpha = await refNamed("Toggle alpha");
    // A page-side re-render drops alpha; beta's checkbox now sits where
    // alpha's saved nth-of-type selector points.
    await cmdEval(ctx, "(todos.splice(0, 1), render(), todos.length)");
    await expect(cmdCheck(ctx, alpha)).rejects.toThrow(stale(alpha));
    expect(await checked("Toggle beta")).toBe("false");
  }, 60_000);

  test("after goto, a ref from the previous document fails with the message", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const submit = await refNamed("Submit");
    await cmdGoto(ctx, `${base}/kitchen-sink.html`);
    const t0 = performance.now();
    await expect(cmdClick(ctx, submit)).rejects.toThrow(stale(submit));
    expect(performance.now() - t0).toBeLessThan(1000);
    // The CLI classifies the message as a user error.
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "click", submit],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(stale(submit));
    expect(code).toBe(1);
  }, 60_000);

  test("after reload, a ref from the previous document fails with the message", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const name = await refNamed("Name");
    await cmdHistory(ctx, "reload");
    await expect(cmdFill(ctx, name, "x")).rejects.toThrow(stale(name));
    expect(await cmdEval(ctx, "document.getElementById('name').value")).toBe("");
  }, 60_000);

  // A long-lived daemon may hold a page the previous bowser snapshotted: its
  // store has no byRef map. The new scripts must work with it, not throw.
  const OLD_STORE = "(window[Symbol.for('bowser.aria-refs')] = { refs: new WeakMap(), last: 5 }, 'planted')";

  test("snapshot on a page with a previous version's ref store works and continues its numbering", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdEval(ctx, OLD_STORE);
    await cmdSnapshot(ctx);
    const ids = (await loadState(ctx.session))!.refs.map((r) => Number(r.id.slice(1)));
    expect(Math.min(...ids)).toBe(6);
  }, 60_000);

  test("an action on a page with a previous version's ref store fails as stale, exit 1", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const submit = await refNamed("Submit");
    await cmdGoto(ctx, `${base}/kitchen-sink.html`);
    await cmdEval(ctx, OLD_STORE);
    await expect(cmdClick(ctx, submit)).rejects.toThrow(stale(submit));
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "click", submit],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(stale(submit));
    expect(code).toBe(1);
  }, 60_000);

  test("a hidden element is not stale: its ref keeps today's behaviour", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const agree = await refNamed("Agree");
    const hover = await refNamed("Hover me");
    // Still connected, no longer visible. check and hover act through page
    // scripts that do not wait for visibility, so today both go through.
    await cmdEval(ctx, "(document.getElementById('agree').style.visibility = 'hidden', document.getElementById('hoverme').style.display = 'none')");
    await cmdCheck(ctx, agree);
    expect(await checked("Agree")).toBe("true");
    await cmdHover(ctx, hover);
    expect(await cmdEval(ctx, "document.getElementById('hovered').textContent")).toBe("hovered");
  }, 60_000);

  test("refs from the current snapshot work for click, fill, hover, select, check and uncheck", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    await cmdFill(ctx, await refNamed("Name"), "ada");
    await cmdClick(ctx, await refNamed("Submit"));
    expect(await cmdEval(ctx, "document.getElementById('submitted').textContent")).toContain("submitted:ada");
    await cmdHover(ctx, await refNamed("Hover me"));
    expect(await cmdEval(ctx, "document.getElementById('hovered').textContent")).toContain("hovered");
    await cmdSelect(ctx, await refNamed("Color"), "blue");
    expect(await cmdEval(ctx, "document.getElementById('color').value")).toContain("blue");
    const agree = await refNamed("Agree");
    await cmdCheck(ctx, agree);
    expect(await checked("Agree")).toBe("true");
    await cmdUncheck(ctx, agree);
    expect(await checked("Agree")).toBe("false");
  }, 60_000);
});
