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

import type { CommandContext } from "../src/commands/context.ts";
import {
  cmdCheck, cmdClick, cmdFill, cmdHover, cmdSelect, cmdUncheck,
} from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { SNAPSHOT_SCRIPT } from "../src/page-scripts.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;
const FIXTURES = join(import.meta.dir, "fixtures");

// ET-21: a button whose click relabels it and counts the clicks.
const RELABEL = `<!doctype html><title>relabel</title>
<button id="buy" onclick="window.clicks = (window.clicks || 0) + 1; this.textContent = 'Delete account'">Buy A</button>
<button id="save">Save <span style="display:none">Delete</span></button>
<button id="send">Send <b>now</b></button>`;

const stale = (ref: string) => `ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`;
const gone = (ref: string) => `ref '${ref}' is from a page that is no longer loaded; take a new snapshot`;

// #105: pages whose OK button and link get the same refs in every document.
const docPage = (title: string, next: string) =>
  `<!doctype html><title>${title}</title><button onclick="document.title = '${title} clicked'">OK</button> <a href="${next}">next</a>`;

/** The tree text inside the ```yaml fence of `snapshot`'s output. */
function tree(out: string): string {
  const m = out.match(/\n```yaml\n([\s\S]*)\n```$/);
  if (!m) throw new Error(`no yaml fence in snapshot output:\n${out}`);
  return m[1]!;
}

runOrSkip("e2e: a stale ref fails at once", () => {
  const ctx: CommandContext = { session: "staleref", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-staleref-"));
    process.env.HOME = tmp;
    const pages: Record<string, string> = {
      "/todo-app.html": "todo-app.html",
      "/kitchen-sink.html": "kitchen-sink.html",
    };
    server = Bun.serve({
      port: 0,
      // /doc-slow answers after the 10 s navigation cap.
      idleTimeout: 30,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const doc = { "/doc-a": docPage("A", "/doc-b"), "/doc-b": docPage("B", "/doc-a"), "/doc-pending": docPage("A", "/doc-slow"), "/doc-slow": docPage("S", "/doc-a") }[path];
        if (path === "/doc-slow") await Bun.sleep(14_000);
        if (doc) return new Response(doc, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (new URL(req.url).pathname === "/relabel.html") {
          return new Response(RELABEL, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
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
    await expect(cmdClick(ctx, submit)).rejects.toThrow(gone(submit));
    expect(performance.now() - t0).toBeLessThan(1000);
    // The CLI classifies the message as a user error.
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "click", submit],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(gone(submit));
    expect(code).toBe(1);
  }, 60_000);

  test("after reload, a ref from the previous document fails with the message", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const name = await refNamed("Name");
    await cmdHistory(ctx, "reload");
    await expect(cmdFill(ctx, name, "x")).rejects.toThrow(gone(name));
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
    expect((await loadState(ctx.session))!.doc).toMatch(/^[0-9a-f]{32}$/);
  }, 60_000);

  test("an action on a page with a previous version's ref store is refused as from another page, exit 1", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const submit = await refNamed("Submit");
    await cmdGoto(ctx, `${base}/kitchen-sink.html`);
    await cmdEval(ctx, OLD_STORE);
    await expect(cmdClick(ctx, submit)).rejects.toThrow(gone(submit));
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "click", submit],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(gone(submit));
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

  // The name of an element hidden now leaves out only descendants hidden in
  // their own right, as the snapshot of the visible element did.
  for (const [how, hide] of [["display", "display = 'none'"], ["visibility", "visibility = 'hidden'"]] as const) {
    test(`#80: a ref hidden by ${how} since the snapshot keeps its name and is not refused`, async () => {
      await cmdOpen(ctx, `${base}/relabel.html`);
      await cmdSnapshot(ctx);
      const save = await refNamed("Save");
      const send = await refNamed("Send now");
      await cmdEval(ctx, `(document.getElementById('save').style.${hide}, document.getElementById('send').style.${hide}, 1)`);
      expect(await cmdHover(ctx, save)).toBe(`hovered ${save}`);
      expect(await cmdHover(ctx, send)).toBe(`hovered ${send}`);
    }, 60_000);
  }

  test("#80: a ref whose element changed its name is refused, exit 1, and the element is not clicked", async () => {
    await cmdOpen(ctx, `${base}/relabel.html`);
    await cmdSnapshot(ctx);
    const buy = await refNamed("Buy A");
    await cmdClick(ctx, buy);
    const clicks = "String(window.clicks)";
    expect(await cmdEval(ctx, clicks)).toBe("1");
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "click", buy],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(`ref '${buy}' now points to button "Delete account", not button "Buy A"; take a new snapshot`);
    expect(code).toBe(1);
    expect(await cmdEval(ctx, clicks)).toBe("1");
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

  /** The CLI on this session, as an agent runs it: its stderr and exit code. */
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, ...args],
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code, stderr };
  };
  const title = () => cmdEval(ctx, "document.title");

  test("#105: after go-back restores a page from the cache, a ref from the page it left is refused, exit 1", async () => {
    await cmdOpen(ctx, `${base}/doc-a`);
    await cmdSnapshot(ctx);
    await cmdClick(ctx, await refNamed("next"));
    await cmdSnapshot(ctx);
    const ok = await refNamed("OK");
    await cmdHistory(ctx, "back");
    expect(await title()).toBe("A");
    // The case under test: A came back with its window, and so with its ref store.
    expect(await cmdEval(ctx, "String(!!window[Symbol.for('bowser.aria-refs')])")).toBe("true");
    const r = await cli(["click", ok]);
    expect(r.stderr).toContain(gone(ok));
    expect(r.code).toBe(1);
    expect(await title()).toBe("A");
  }, 60_000);

  test("#105: a ref resolved while a navigation is pending waits for it and is refused on the page that landed", async () => {
    await cmdOpen(ctx, `${base}/doc-pending`);
    await cmdSnapshot(ctx);
    const ok = await refNamed("OK");
    // Returns after the 10 s navigation cap, with /doc-slow still pending.
    await cmdClick(ctx, await refNamed("next"));
    const short = await cli(["click", ok], { BOWSER_OP_TIMEOUT_MS: "2000" });
    expect(short.stderr).toContain(`page is still loading ${base}/doc-slow`);
    expect(short.code).toBe(2);
    const r = await cli(["click", ok]);
    expect(r.stderr).toContain(gone(ok));
    expect(r.code).toBe(1);
    expect(await cmdEval(ctx, "location.pathname")).toBe("/doc-slow");
    expect(await title()).toBe("S");
  }, 60_000);

  test("#105: a ref is refused on a document whose own snapshot was never saved", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const submit = await refNamed("Submit");
    await cmdGoto(ctx, `${base}/kitchen-sink.html`);
    // A snapshot whose evaluate ran in the page and whose save was lost.
    await cmdEval(ctx, SNAPSHOT_SCRIPT);
    await expect(cmdClick(ctx, submit)).rejects.toThrow(gone(submit));
    expect(await cmdEval(ctx, "document.getElementById('submitted').textContent")).toBe("");
  }, 60_000);

  test("#105: pushState and a hash change keep the document, so its refs still work", async () => {
    await cmdOpen(ctx, `${base}/kitchen-sink.html`);
    await cmdSnapshot(ctx);
    const hover = await refNamed("Hover me");
    await cmdEval(ctx, "(history.pushState({}, '', '/other'), location.hash = 'x', location.href)");
    expect(await cmdHover(ctx, hover)).toBe(`hovered ${hover}`);
  }, 60_000);
});
