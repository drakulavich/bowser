// End-to-end: JavaScript dialogs through the real CLI commands and daemon.
// Spec: docs/superpowers/specs/2026-09-26-dialogs-design.md, Acceptance 2 and 3.
//
// Every dialog is answered the moment it opens (the one-shot answer if set,
// else dismissed) and reported by the command that caused it. Before this, a
// click that opened confirm() on Chromium hung until the op timeout and
// wedged the session. The expectations are the same on both backends; on
// WebKit they are todo until the page shim lands (Task 4).
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
import { cmdClick } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const CHROME = E2E && resolveBackend().kind === "chrome";
const run = E2E ? describe : describe.skip;
/** Both backends, same expectations. WebKit needs the page shim (Task 4). */
const both = CHROME ? test : test.todo;
/** Chromium only: a dialog during page load (WebKit's engine answers those). */
const chromeOnly = CHROME ? test : test.skip;

const PAGE = `<!doctype html><title>Dialogs</title>
<button onclick="out.textContent = 'confirm:' + confirm('sure?')">Confirm</button>
<button onclick="out.textContent = 'prompt:' + prompt('name?', 'def')">Prompt</button>
<button onclick="alert('hi'); out.textContent = 'alert:done'">Alert</button>
<button onclick="confirm('one'); alert('two'); out.textContent = 'two:done'">Two</button>
<p id="out"></p>`;

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
      fetch: (req) => new Response(new URL(req.url).search === "?load=1" ? LOAD_PAGE : PAGE, {
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

  both("confirm with no answer set: dismissed at once with the hint, and the session keeps working", async () => {
    await fresh();
    expect(await click("Confirm")).toEndWith(`### Modal state\n${line("confirm", "sure?", HINT)}`);
    expect(await out()).toBe("confirm:false");
    expect(await cmdEval(ctx, "1 + 1")).toBe("2");
  }, 60_000);

  both("dialog-accept, then a confirm is accepted", async () => {
    await fresh();
    expect(await cmdDialog(ctx, true)).toBe("next dialog will be accepted");
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    expect(await out()).toBe("confirm:true");
  }, 60_000);

  both("dialog-accept <text>, then a prompt gets the text", async () => {
    await fresh();
    await cmdDialog(ctx, true, "typed");
    expect(await click("Prompt")).toEndWith(line("prompt", "name?", "accepted"));
    expect(await out()).toBe("prompt:typed");
  }, 60_000);

  both("dialog-dismiss, then a prompt is dismissed without the hint", async () => {
    await fresh();
    expect(await cmdDialog(ctx, false)).toBe("next dialog will be dismissed");
    expect(await click("Prompt")).toEndWith(line("prompt", "name?", "dismissed"));
    expect(await out()).toBe("prompt:null");
  }, 60_000);

  both("an alert is reported and the page continues", async () => {
    await fresh();
    expect(await click("Alert")).toContain(line("alert", "hi", ""));
    expect(await out()).toBe("alert:done");
  }, 60_000);

  both("the one-shot answer is used once: a second confirm is dismissed", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", "accepted"));
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", HINT));
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  both("a one-shot answer does not survive goto", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    await cmdGoto(ctx, url);
    await cmdSnapshot(ctx);
    expect(await click("Confirm")).toEndWith(line("confirm", "sure?", HINT));
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  both("two dialogs from one click are both reported, in order", async () => {
    await fresh();
    const text = await click("Two");
    expect(text).toEndWith(`### Modal state\n${line("confirm", "one", HINT)}\n${line("alert", "two", HINT)}`);
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
});
