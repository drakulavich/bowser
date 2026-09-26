// End-to-end: JavaScript dialogs through the real CLI commands and daemon.
// Spec: docs/superpowers/specs/2026-09-26-dialogs-design.md, Acceptance 2.
//
// The Chromium half runs only when the resolved backend is chrome; on WebKit
// it skips (the WebKit half is Task 2's). Before this, a click that opened
// confirm() on Chromium hung until the op timeout and wedged the session.
//
//   BOWSER_E2E=1 BOWSER_BACKEND=chrome \
//     BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
//     bun test tests/e2e-dialogs.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdDialog } from "../src/commands/dialog.ts";
import { cmdClick } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const CHROME = E2E && resolveBackend().kind === "chrome";
const onChrome = CHROME ? describe : describe.skip;

const PAGE = `<!doctype html><title>Dialogs</title>
<button onclick="out.textContent = 'confirm:' + confirm('sure?')">Confirm</button>
<button onclick="out.textContent = 'prompt:' + prompt('name?', 'def')">Prompt</button>
<button onclick="alert('hi'); out.textContent = 'alert:done'">Alert</button>
<button onclick="out.textContent = 'plain'">Plain</button>
<p id="out"></p>`;

const pending = (type: string, message: string) =>
  `### Modal state\n- ["${type}" dialog with message "${message}"]: can be handled by dialog-accept or dialog-dismiss`;
const openError = (type: string, message: string) =>
  `${/^[aeiou]/.test(type) ? "an" : "a"} ${type} dialog is open ("${message}"); run dialog-accept or dialog-dismiss`;

onChrome("e2e: dialogs on Chromium", () => {
  const ctx: CommandContext = { session: "dialogs", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let url: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-dialogs-"));
    process.env.HOME = tmp;
    if (!detectChromium()) throw new Error("BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found.");
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
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
  const ref = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    return r.id;
  };
  const out = () => cmdEval(ctx, "document.getElementById('out').textContent");
  /** Click, and require it back well before the op timeout. */
  const timedClick = async (name: string): Promise<string> => {
    const target = await ref(name);
    const t0 = performance.now();
    const text = await cmdClick(ctx, target);
    expect(performance.now() - t0).toBeLessThan(2000);
    return text;
  };

  test("confirm: click returns at once with it pending, a page command in between fails, accept answers it", async () => {
    await fresh();
    const clicked = await timedClick("Confirm");
    expect(clicked).toContain(pending("confirm", "sure?"));
    await expect(out()).rejects.toThrow(openError("confirm", "sure?"));
    expect(await cmdDialog(ctx, true)).toBe('["confirm" dialog with message "sure?"]: accepted');
    expect(await out()).toBe("confirm:true");
  }, 60_000);

  test("confirm: dismiss answers false", async () => {
    await fresh();
    await timedClick("Confirm");
    expect(await cmdDialog(ctx, false)).toBe('["confirm" dialog with message "sure?"]: dismissed');
    expect(await out()).toBe("confirm:false");
  }, 60_000);

  test("prompt: accept with text answers the prompt with it", async () => {
    await fresh();
    expect(await timedClick("Prompt")).toContain(pending("prompt", "name?"));
    expect(await cmdDialog(ctx, true, "typed")).toBe('["prompt" dialog with message "name?"]: accepted');
    expect(await out()).toBe("prompt:typed");
  }, 60_000);

  test("alert: pending until accepted, then the page continues", async () => {
    await fresh();
    expect(await timedClick("Alert")).toContain(pending("alert", "hi"));
    expect(await out().catch((e: Error) => e.message)).toBe(openError("alert", "hi"));
    await cmdDialog(ctx, true);
    expect(await out()).toBe("alert:done");
  }, 60_000);

  test("regression: after a dialog the session still works", async () => {
    await fresh();
    await timedClick("Confirm");
    await cmdDialog(ctx, true);
    // The click the dialog blocked has settled in the background; nothing
    // is queued behind it and every kind of command answers promptly.
    const t0 = performance.now();
    await cmdSnapshot(ctx);
    expect(await timedClick("Plain")).toBe(`clicked ${await ref("Plain")} (button "Plain")`);
    expect(await out()).toBe("plain");
    await cmdGoto(ctx, url);
    expect(await cmdEval(ctx, "document.title")).toBe("Dialogs");
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 60_000);

  test("a page command while a dialog is open exits 1 with the user error", async () => {
    await fresh();
    await timedClick("Confirm");
    const p = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", ctx.session, "eval", "1"],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(stderr).toContain(openError("confirm", "sure?"));
    expect(code).toBe(1);
    await cmdDialog(ctx, false);
  }, 60_000);

  test("snapshot while a dialog is open shows the modal state and no tree", async () => {
    await fresh();
    await timedClick("Confirm");
    const snap = await cmdSnapshot(ctx);
    expect(snap).toContain("### Page");
    expect(snap).toEndWith(pending("confirm", "sure?"));
    expect(snap).not.toContain("```yaml");
    await cmdDialog(ctx, true);
  }, 60_000);

  test("eval that opens a dialog returns with it pending", async () => {
    await fresh();
    const t0 = performance.now();
    expect(await cmdEval(ctx, "confirm('from eval')")).toBe(`\n${pending("confirm", "from eval")}`);
    expect(performance.now() - t0).toBeLessThan(2000);
    await cmdDialog(ctx, true);
    expect(await cmdEval(ctx, "1 + 1")).toBe("2");
  }, 60_000);

  test("one-shot: an answer given before the click is applied, with no pending state", async () => {
    await fresh();
    expect(await cmdDialog(ctx, true, "early")).toBe("next dialog will be accepted");
    const clicked = await timedClick("Prompt");
    expect(clicked).toContain('- ["prompt" dialog with message "name?"]: accepted');
    expect(clicked).not.toContain("can be handled");
    expect(await out()).toBe("prompt:early");
    expect(await cmdDialog(ctx, false)).toBe("next dialog will be dismissed");
    expect(await timedClick("Confirm")).toContain('- ["confirm" dialog with message "sure?"]: dismissed');
    expect(await out()).toBe("confirm:false");
    // Used once: the next dialog is pending again.
    expect(await timedClick("Confirm")).toContain(pending("confirm", "sure?"));
    await cmdDialog(ctx, true);
  }, 60_000);

  test("one-shot: a navigation drops it", async () => {
    await fresh();
    await cmdDialog(ctx, true);
    await cmdGoto(ctx, url);
    await cmdSnapshot(ctx);
    expect(await timedClick("Confirm")).toContain(pending("confirm", "sure?"));
    await cmdDialog(ctx, false);
  }, 60_000);
});
