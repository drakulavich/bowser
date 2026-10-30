// End-to-end: a ref action never acts on a document that replaced its
// snapshot's after `resolve` answered (#111). The connection below navigates
// to B between the command's requests, where a page's own navigation lands.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-ref-window.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdCheck, cmdClick, cmdFill, cmdHover, cmdSelect, cmdUncheck } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { connectOrSpawn } from "../src/daemon/client.ts";
import type { DaemonConnection, Op } from "../src/daemon/protocol.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

const page = (title: string) => `<!doctype html><title>${title}</title>
<input id="box" type="checkbox" aria-label="Box"> <input id="on" type="checkbox" aria-label="On" checked>
<select id="color" aria-label="Color"><option>red</option><option>blue</option></select>
<button id="go" onclick="document.title += ' clicked'" onmouseover="document.body.dataset.hovered = 'yes'">Go</button>
<input id="name" aria-label="Name"> <div id="notes" contenteditable="true" aria-label="Notes"></div>`;

const gone = (ref: string) => `ref '${ref}' is from a page that is no longer loaded; take a new snapshot`;

runOrSkip("e2e: a ref action refuses a document that replaced its snapshot's (#111)", () => {
  const ctx: CommandContext = { session: "refwindow", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-refwindow-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const title = { "/a": "A", "/b": "B" }[new URL(req.url).pathname];
        if (!title) return new Response("not found", { status: 404 });
        return new Response(page(title), { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** The command's connection, which moves the page to B once the `nth` reply to `op` is in. */
  const navigatingAfter = (op: Op, nth = 1): CommandContext => ({
    ...ctx,
    connect: async (session, opts) => {
      const c = await connectOrSpawn(session, opts);
      let seen = 0;
      const request = (async (...params: Parameters<DaemonConnection["request"]>) => {
        const res = await c.request(...params);
        if (params[0] === op && ++seen === nth) await c.request("navigate", [`${base}/b`]);
        return res;
      }) as DaemonConnection["request"];
      return { request, dialogs: () => c.dialogs(), reportDialogs: () => c.reportDialogs(), close: () => c.close() };
    },
  });

  const onA = async (name: string): Promise<string> => {
    await cmdOpen(ctx, `${base}/a`);
    await cmdSnapshot(ctx);
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} on A`);
    return r.id;
  };

  const onB = (expr: string) => cmdEval(ctx, `document.title === "B" ? String(${expr}) : "not on B: " + document.title`);

  test("check, uncheck, select and hover act on nothing in B", async () => {
    let ref = await onA("Box");
    await expect(cmdCheck(navigatingAfter("resolve"), ref)).rejects.toThrow(gone(ref));
    expect(await onB("document.getElementById('box').checked")).toBe("false");

    ref = await onA("On");
    await expect(cmdUncheck(navigatingAfter("resolve"), ref)).rejects.toThrow(gone(ref));
    expect(await onB("document.getElementById('on').checked")).toBe("true");

    ref = await onA("Color");
    await expect(cmdSelect(navigatingAfter("resolve"), ref, "blue")).rejects.toThrow(gone(ref));
    expect(await onB("document.getElementById('color').value")).toBe("red");

    ref = await onA("Go");
    await expect(cmdHover(navigatingAfter("resolve"), ref)).rejects.toThrow(gone(ref));
    expect(await onB("document.body.dataset.hovered")).toBe("undefined");
  }, 60_000);

  test("click does not click B's button", async () => {
    const ref = await onA("Go");
    await expect(cmdClick(navigatingAfter("resolve"), ref)).rejects.toThrow(gone(ref));
    expect(await onB("document.title")).toBe("B");
  }, 60_000);

  for (const [step, op, name] of [
    ["resolve", "resolve", "Name"],
    ["its click", "click", "Name"],
    ["its fill script", "evaluate", "Notes"],
  ] as const) {
    test(`fill with B loaded after ${step} leaves B's ${name} empty`, async () => {
      const ref = await onA(name);
      await expect(cmdFill(navigatingAfter(op), ref, "typed")).rejects.toThrow(gone(ref));
      expect(await onB(`document.getElementById('name').value + document.getElementById('notes').textContent`)).toBe("");
    }, 60_000);
  }
});
