// End-to-end: wait-for waits for a client-side route change and for text a
// script adds, and says what it waited for when the budget runs out (#114).
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-wait-for.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen, cmdWaitFor } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

/** As on carrefouruae.com (2026-10-02): the route changes by pushState a
 *  second after the click, and the new view's text comes later still. */
const PAGE = `<!doctype html><title>Home</title>
<button onclick="setTimeout(() => history.pushState({}, '', '/moved'), 1000); setTimeout(() => document.body.append('Moved here'), 1500)">Go</button>`;

runOrSkip("e2e: wait-for (#114)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  const ctx: CommandContext = { session: "waitfor", json: false };

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    tmp = await mkdtemp(join(tmpdir(), "bowser-waitfor-"));
    process.env.HOME = tmp;
    delete process.env.BOWSER_OP_TIMEOUT_MS;
    server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
    base = server.url.toString().replace(/\/$/, "");
    await cmdOpen(ctx, `${base}/`);
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  test("waits for the pushState route and the text after a click, and saves the URL", async () => {
    await cmdEval(ctx, "document.querySelector('button').click(), 1");
    const t0 = performance.now();
    expect(await cmdWaitFor(ctx, { url: "/moved" })).toBe(`${base}/moved`);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect((await loadState(ctx.session))?.url).toBe(`${base}/moved`);
    expect(await cmdWaitFor(ctx, { text: "Moved here" })).toBe(`${base}/moved`);
  }, 30_000);

  test("text that never comes fails within the budget, naming the text and the page", async () => {
    const at = await cmdEval(ctx, "location.href");
    process.env.BOWSER_OP_TIMEOUT_MS = "1500";
    try {
      const t0 = performance.now();
      const err = await cmdWaitFor(ctx, { text: "Never" }).then(() => undefined, (e: unknown) => e);
      expect((err as Error | undefined)?.message).toBe(`wait-for: no text "Never" after 1500ms; the page is at ${at}`);
      expect(performance.now() - t0).toBeLessThan(2500);
    } finally {
      delete process.env.BOWSER_OP_TIMEOUT_MS;
    }
  }, 30_000);
});
