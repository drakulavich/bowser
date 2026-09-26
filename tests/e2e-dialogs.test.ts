// End-to-end: JavaScript dialogs through the real CLI commands and daemon.
// Spec: docs/superpowers/specs/2026-09-26-dialogs-design.md, Acceptance 2 and 3.
//
// Every dialog is answered the moment it opens (the one-shot answer if set,
// else dismissed) and reported by the command that caused it. A page shim
// answers dialogs (page-scripts.ts dialogShim). A dialog raised before bowser
// first acts on a new document is answered by the engine and not reported.
//
//   BOWSER_E2E=1 bun test tests/e2e-dialogs.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdDialog } from "../src/commands/dialog.ts";
import { cmdClick, cmdPress } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdScreenshot, cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const run = E2E ? describe : describe.skip;

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
<p id="out"></p>`;

// A page whose key handler opens a confirm(), for an action with no eval before it.
const KEYS_PAGE = `<!doctype html><title>Keys</title>
<script>addEventListener('keydown', () => { document.title = 'key:' + confirm('key?') })</script>`;

const OTHER_PAGE = `<!doctype html><title>Other</title><p>other</p>`;

// P1 F23: a focused input in a form that submits to /two.
const FORM_PAGE = `<!doctype html><title>Form</title>
<form action="/two"><input id="q" name="q" value="x"></form>`;

// P1 F24: the page defines its own confirm.
const OWN_PAGE = `<!doctype html><title>Own</title>
<script>window.confirm = m => { out.textContent = 'custom:' + m; return true }</script>
<p id="out">none</p><button onclick="var r = confirm('really'); out.textContent += ' r=' + r">C</button>`;

// P1 F25: a same-origin frame, and a confirm raised on its window from the top.
const FRAME_PAGE = (frameSrc: string) => `<!doctype html><title>Frame</title>
<iframe src="${frameSrc}"></iframe>
<button onclick="out.textContent = 'viaframe:' + frames[0].confirm('frame')">ViaFrame</button>
<button onclick="out.textContent = 'top:' + confirm('top')">Top</button>
<p id="out"></p>`;

const INNER_PAGE = `<!doctype html><title>Inner</title>
<button onclick="document.body.dataset.r = String(confirm('inner'))">Inner</button>`;

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
      fetch: (req) => {
        const u = new URL(req.url);
        const pages: Record<string, string> = {
          "?keys=1": KEYS_PAGE, "?other=1": OTHER_PAGE, "?form=1": FORM_PAGE, "?own=1": OWN_PAGE,
          "?frame=1": FRAME_PAGE("/?inner=1"), "?inner=1": INNER_PAGE,
          // localhost and 127.0.0.1 are different origins.
          "?xframe=1": FRAME_PAGE(`http://127.0.0.1:${u.port}/?inner=1`),
        };
        const body = u.pathname === "/two" ? OTHER_PAGE : pages[u.search] ?? PAGE;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    url = `http://localhost:${server.port}/`;
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

  test("a confirm whose handler navigates is answered; on WebKit its report is lost with the old document (documented limitation)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    const text = await click("Leave");
    // The navigation happened, so the confirm returned true: the answer was applied.
    expect(await cmdEval(ctx, "location.search")).toBe("?left=1");
    // Documented limitation (spec item 5, README "Dialogs"): the page
    // shim's log lived in the document the handler navigated away from.
    expect(text).not.toContain("Modal state");
  }, 60_000);

  test("an answer set on a page is gone when back restores that page from the back-forward cache", async () => {
    await fresh();
    await cmdEval(ctx, "(window.kept = 'yes', 1)");
    await cmdDialog(ctx, true);
    await cmdGoto(ctx, `${url}?other=1`);
    await cmdHistory(ctx, "back");
    // WebKit restores the document itself, shim and answer included
    // (measured). The answer must be gone all the same.
    expect(await cmdEval(ctx, "window.kept")).toBe("yes");
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

  test("a confirm the page saved at load: the engine dismisses it unreported and the answer waits (documented)", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    const text = await click("Saved");
    // Documented limitation (spec item 5): a reference the page saved before
    // bowser first acted skips the shim, so the engine dismisses it.
    expect(text).not.toContain("Modal state");
    expect(await out()).toBe("saved:false");
    // The prepared answer is still set, for the next dialog the shim sees.
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
  }, 60_000);

  // P1 F23: a dialog a timer opens between commands is reported by the next
  // command even when that command leaves the document.
  const timer = async () => {
    await cmdEval(ctx, "(setTimeout(() => { window.fired = confirm('timer') }, 200), 1)");
    await Bun.sleep(1000);
  };
  const TIMER = `### Modal state\n${line("confirm", "timer", HINT)}`;

  test("a timer confirm, then reload: reload reports it", async () => {
    await fresh();
    await timer();
    expect(await cmdHistory(ctx, "reload")).toContain(TIMER);
    expect(await cmdSnapshot(ctx)).not.toContain("Modal state");
  }, 60_000);

  test("a timer confirm, then goto: goto reports it", async () => {
    await fresh();
    await timer();
    expect(await cmdGoto(ctx, `${url}?other=1`)).toContain(TIMER);
  }, 60_000);

  test("a timer confirm, then open: open reports it", async () => {
    await fresh();
    await timer();
    expect(await cmdOpen(ctx, `${url}?other=1`)).toContain(TIMER);
  }, 60_000);

  test("a timer confirm, then go-back: go-back reports it", async () => {
    await fresh();
    await cmdGoto(ctx, `${url}?other=1`);
    await timer();
    expect(await cmdHistory(ctx, "back")).toContain(TIMER);
  }, 60_000);

  test("a timer confirm, then press Enter submitting a form: press reports it, and go-back does not bring it back", async () => {
    // A session of its own, so ?form=1 is its first page. WebKit's go-back
    // skipped ?form=1 when an earlier page was in the history (measured, Bun
    // 1.4.2, with or without bowser's click on the input), and the restore
    // from the back-forward cache is the case under test.
    const own: CommandContext = { session: `dialogs-form-${process.pid}`, json: false };
    try {
      await cmdOpen(own, `${url}?form=1`);
      await cmdEval(own, "(document.getElementById('q').focus(), 1)");
      await cmdEval(own, "(setTimeout(() => { window.fired = confirm('timer') }, 200), 1)");
      await Bun.sleep(1000);
      expect(await cmdPress(own, "Enter")).toContain(TIMER);
      expect(await cmdEval(own, "location.pathname")).toBe("/two");
      const back = await cmdHistory(own, "back");
      expect(back).toContain("?form=1");
      expect(back).not.toContain("Modal state");
      // The timer's page came back from the back-forward cache, window and all.
      expect(await cmdEval(own, "String(window.fired)")).toBe("false");
      expect(await cmdSnapshot(own)).not.toContain("Modal state");
    } finally {
      await cmdClose(own);
    }
  }, 60_000);

  // P1 F24, option 1: the shim replaces only the engine's own functions.
  test("a page-defined confirm runs, and nothing is reported", async () => {
    await cmdOpen(ctx, `${url}?own=1`);
    await cmdSnapshot(ctx);
    expect(await click("C")).not.toContain("Modal state");
    expect(await out()).toBe("custom:really r=true");
  }, 60_000);

  // P1 F25, option 1: same-origin frames get the shim and the top answer.
  test("a same-origin iframe confirm is reported and takes the prepared answer, which does not carry over", async () => {
    await cmdOpen(ctx, `${url}?frame=1`);
    await cmdSnapshot(ctx);
    await cmdDialog(ctx, true);
    expect(await click("ViaFrame")).toEndWith(`### Modal state\n${line("confirm", "frame", "accepted")}`);
    expect(await out()).toBe("viaframe:true");
    expect(await click("Top")).toEndWith(line("confirm", "top", HINT));
    expect(await out()).toBe("top:false");
  }, 60_000);

  test("a confirm from a button inside a same-origin iframe is reported", async () => {
    await cmdOpen(ctx, `${url}?frame=1`);
    await cmdDialog(ctx, true);
    const text = await cmdEval(ctx, "(frames[0].document.querySelector('button').click(), frames[0].document.body.dataset.r)");
    expect(text).toStartWith("true");
    expect(text).toContain(line("confirm", "inner", "accepted"));
  }, 60_000);

  test("a cross-origin iframe is skipped: the top page's dialogs are still reported (its own are a documented limit)", async () => {
    await cmdOpen(ctx, `${url}?xframe=1`);
    await cmdSnapshot(ctx);
    expect(await click("Top")).toEndWith(line("confirm", "top", HINT));
    expect(await out()).toBe("top:false");
  }, 60_000);
});
