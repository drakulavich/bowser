// End-to-end: JavaScript dialogs through the real CLI commands and daemon.
// Spec: docs/superpowers/specs/2026-09-26-dialogs-design.md, Acceptance 2 and 3.
//
// Every dialog is answered the moment it opens (the one-shot answer if set,
// else dismissed) and reported by the command that caused it. Before this, a
// click that opened confirm() on Chromium hung until the op timeout and
// wedged the session. The expectations are the same on both backends: on
// WebKit a page shim answers dialogs (page-scripts.ts dialogShim), and a
// dialog raised before bowser first acts on a new document is answered by
// the engine and not reported, which is why Acceptance 3 is Chromium only.
//
//   BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test tests/e2e-dialogs.test.ts
//
//   BOWSER_E2E=1 BOWSER_BACKEND=chrome \
//     BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
//     bun test tests/e2e-dialogs.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdDialog } from "../src/commands/dialog.ts";
import { cmdClick, cmdPress } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdScreenshot, cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const CHROME = E2E && resolveBackend().kind === "chrome";
const run = E2E ? describe : describe.skip;
/** Chromium only: a dialog during page load (WebKit's engine answers those). */
const chromeOnly = CHROME ? test : test.skip;

const PAGE = `<!doctype html><title>Dialogs</title>
<script>const savedConfirm = window.confirm</script>
<button onclick="out.textContent = 'saved:' + savedConfirm('saved?')">Saved</button>
<button onclick="out.textContent = 'confirm:' + confirm('sure?')">Confirm</button>
<button onclick="out.textContent = 'prompt:' + prompt('name?', 'def')">Prompt</button>
<button onclick="alert('hi'); out.textContent = 'alert:done'">Alert</button>
<button onclick="confirm('one'); alert('two'); out.textContent = 'two:done'">Two</button>
<button onclick="setTimeout(() => { out.textContent = 'later:' + confirm('later') }, 500)">Later</button>
<button onclick="if (confirm('Leave?')) location = '/?left=1'">Leave</button>
<button onclick="setTimeout(() => { location = '/?keys=1' }, 300)">Self</button>
<a href="/?load=1">Load</a>
<p id="out"></p>`;

// A page whose key handler opens a confirm(), for an action with no eval before it.
const KEYS_PAGE = `<!doctype html><title>Keys</title>
<script>addEventListener('keydown', () => { document.title = 'key:' + confirm('key?') })</script>`;

const OTHER_PAGE = `<!doctype html><title>Other</title><p>other</p>`;

// A confirm() in an inline script, during the page's very first load.
const LOAD_PAGE = `<!doctype html><title>Load</title>
<script>document.title = 'load:' + confirm('onload?')</script>`;

const line = (type: string, message: string, what: string) => `- ["${type}" dialog with message "${message}"]: ${what}`;
const HINT = "dismissed (run dialog-accept before the action to accept it)";

run("e2e: dialogs", () => {
  const ctx: CommandContext = { session: "dialogs", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let url: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-dialogs-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(({ "?load=1": LOAD_PAGE, "?keys=1": KEYS_PAGE, "?other=1": OTHER_PAGE } as Record<string, string>)[new URL(req.url).search] ?? PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    url = server.url.toString();
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const fresh = async () => {
    await cmdOpen(ctx, url);
    await cmdSnapshot(ctx);
  };
  const click = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    const t0 = performance.now();
    const text = await cmdClick(ctx, r.id);
    // Well before the op timeout: nothing ever waits on a dialog.
    expect(performance.now() - t0).toBeLessThan(2000);
    return text;
  };
  const out = () => cmdEval(ctx, "document.getElementById('out').textContent");

  test("confirm with no answer set: dismissed at once with the hint, and the session keeps working", async () => {
    await fresh();
    expect(await click("Confirm")).toEndWith(`### Modal state\n${line("confirm", "sure?", HINT)}`);
    expect(await out()).toBe("confirm:false");
    expect(await cmdEval(ctx, "1 + 1")).toBe("2");
  }, 60_000);

  test("dialog-accept, then a confirm is accepted", async () => {
    await fresh();
    expect(await cmdDialog(ctx, true)).toBe("next dialog will be accepted");
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    expect(await out()).toBe("confirm:true");
  }, 60_000);

  test("dialog-accept <text>, then a prompt gets the text", async () => {
    await fresh();
    await cmdDialog(ctx, true, "typed");
    expect(await click("Prompt")).toEndWith(line("prompt", "name?", "accepted"));
    expect(await out()).toBe("prompt:typed");
  }, 60_000);

  test("dialog-dismiss, then a prompt is dismissed without the hint", async () => {
    await fresh();
    expect(await cmdDialog(ctx, false)).toBe("next dialog will be dismissed");
    expect(await click("Prompt")).toEndWith(line("prompt", "name?", "dismissed"));
    expect(await out()).toBe("prompt:null");
  }, 60_000);

  test("an alert is reported and the page continues", async () => {
    await fresh();
    expect(await click("Alert")).toEndWith(line("alert", "hi", "dismissed"));
    expect(await out()).toBe("alert:done");
  }, 60_000);

  test("the one-shot answer is used once: a second confirm is dismissed", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", HINT));
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  test("a one-shot answer does not survive goto", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    await cmdGoto(ctx, url);
    await cmdSnapshot(ctx);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", HINT));
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  test("two dialogs from one click are both reported, in order", async () => {
    await fresh();
    const text = await click("Two");
    expect(text).toEndWith(`### Modal state\n${line("confirm", "one", HINT)}\n${line("alert", "two", "dismissed")}`);
    expect(await out()).toBe("two:done");
  }, 60_000);

  chromeOnly("a confirm() during the very first page load neither hangs open nor goes unreported", async () => {
    try { await cmdClose(ctx); } catch {}
    const t0 = performance.now();
    const opened = await cmdOpen(ctx, `${url}?load=1`);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(opened).toEndWith(line("confirm", "onload?", HINT));
    expect(await cmdEval(ctx, "document.title")).toBe("load:false");
    const t1 = performance.now();
    expect(await cmdGoto(ctx, `${url}?load=1`)).toEndWith(line("confirm", "onload?", HINT));
    expect(performance.now() - t1).toBeLessThan(2000);
  }, 60_000);

  test("a dialog a timer opens between commands waits for a command that prints it", async () => {
    await fresh();
    expect(await click("Later")).not.toContain("Modal state");
    await Bun.sleep(1000);
    // screenshot prints no dialogs, so it must not take the report.
    expect(await cmdScreenshot(ctx, { filename: join(tmp, "later.png") })).not.toContain("Modal state");
    const snap = await cmdSnapshot(ctx);
    expect(snap).toContain(`### Modal state\n${line("confirm", "later", HINT)}\n### Snapshot`);
    expect(snap).toContain('button "Later"');
    expect(await out()).toBe("later:false");
  }, 60_000);

  chromeOnly("a one-shot answer set on one page does not answer the next page's load-time dialog (goto)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    expect(await cmdGoto(ctx, `${url}?load=1`)).toEndWith(line("confirm", "onload?", HINT));
    expect(await cmdEval(ctx, "document.title")).toBe("load:false");
  }, 60_000);

  chromeOnly("a one-shot answer set on one page does not answer the next page's load-time dialog (click)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    expect(await click("Load")).toEndWith(line("confirm", "onload?", HINT));
    expect(await cmdEval(ctx, "document.title")).toBe("load:false");
  }, 60_000);

  test("a confirm whose handler navigates is answered; on WebKit its report is lost with the old document (documented limitation)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    const text = await click("Leave");
    // The navigation happened, so the confirm returned true: the answer was applied.
    expect(await cmdEval(ctx, "location.search")).toBe("?left=1");
    if (CHROME) {
      expect(text).toEndWith(line("confirm", "Leave?", "accepted"));
    } else {
      // Documented WebKit limitation (spec item 5, README "Dialogs"): the page
      // shim's log lived in the document the handler navigated away from.
      expect(text).not.toContain("Modal state");
    }
  }, 60_000);

  test("an answer set on a page is gone when back restores that page from the back-forward cache", async () => {
    await fresh();
    await cmdEval(ctx, "(window.kept = 'yes', 1)");
    await cmdDialog(ctx, true);
    await cmdGoto(ctx, `${url}?other=1`);
    await cmdHistory(ctx, "back");
    // WebKit restores the document itself, shim and answer included (measured);
    // headless Chromium may load it anew. Either way the answer must be gone.
    if (!CHROME) expect(await cmdEval(ctx, "window.kept")).toBe("yes");
    await cmdSnapshot(ctx);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", HINT));
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  test("after the page navigates itself, the next action's dialog is answered and reported, with no eval before it", async () => {
    await fresh();
    await click("Self");
    await Bun.sleep(1000);
    expect(await cmdPress(ctx, "a")).toEndWith(line("confirm", "key?", HINT));
    expect(await cmdEval(ctx, "document.title")).toBe("key:false");
  }, 60_000);

  test("an iframe navigating does not drop the page's one-shot answer", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    await cmdEval(ctx, "(document.body.append(Object.assign(document.createElement('iframe'), { src: '/?other=1' })), 1)");
    await Bun.sleep(500);
    await cmdEval(ctx, "(document.querySelector('iframe').src = '/?other=2', 1)");
    await Bun.sleep(500);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    expect(await out()).toBe("confirm:true");
  }, 60_000);

  test("a command that fails after a dialog prints its error, then the report on stderr, exit 2; the next command does not replay it", async () => {
    await fresh();
    // Through the real CLI, so stderr and the exit code are the ones a user sees.
    // An expression: eval does not take statements.
    const p = Bun.spawnSync(
      ["bun", join(import.meta.dir, "../src/cli.ts"), `--session=${ctx.session}`, "eval", "(confirm('sure?'), (() => { throw new Error('boom') })())"],
      { env: { ...process.env, HOME: tmp }, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = p.stderr.toString();
    expect(stderr).toStartWith("bowser: ");
    expect(stderr).toContain("boom");
    expect(stderr).toContain(`### Modal state\n${line("confirm", "sure?", HINT)}`);
    expect(p.exitCode).toBe(2);
    expect(await cmdSnapshot(ctx)).not.toContain("Modal state");
  }, 60_000);

  test("a confirm the page saved at load: Chromium answers it; WebKit's engine dismisses it unreported and the answer waits (documented)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    const text = await click("Saved");
    if (CHROME) {
      expect(text).toEndWith(line("confirm", "saved?", "accepted"));
      expect(await out()).toBe("saved:true");
    } else {
      // Documented WebKit limitation (spec item 5): a reference the page saved
      // before bowser first acted skips the shim, so the engine dismisses it.
      expect(text).not.toContain("Modal state");
      expect(await out()).toBe("saved:false");
      // The prepared answer is still set, for the next dialog the shim sees.
      expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    }
  }, 60_000);
});
