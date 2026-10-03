// End-to-end (#116): `reload` of a page whose server is slow returns once the
// new document is live, and a `goto` that cancels a navigation still loading
// lands instead of failing with WebKit's NSURLErrorDomain -999.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-slow-reload.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const SLOW_MS = 2000;

runOrSkip("e2e: navigation over a slow load (#116)", () => {
  const ctx: CommandContext = { session: "slowreload", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  /** Requests for /doc after the first are held SLOW_MS: the reload's are. */
  let docHits = 0;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-slowreload-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/doc" && docHits++ > 0) await Bun.sleep(SLOW_MS);
        if (path === "/slow") await Bun.sleep(SLOW_MS);
        return new Response(`<!doctype html><title>${path}</title><button>OK</button>`, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  async function openDoc(): Promise<void> {
    docHits = 0;
    await cmdOpen(ctx, `${base}/doc`);
  }

  test("goto straight after reload of a slow page lands", async () => {
    await openDoc();
    await cmdHistory(ctx, "reload");
    expect(await cmdGoto(ctx, `${base}/next`)).toBe(`navigated to ${base}/next`);
  }, 60_000);

  test("reload of a slow page returns once the new document is live: an old ref is from a page no longer loaded", async () => {
    await openDoc();
    await cmdSnapshot(ctx);
    const ref = (await loadState(ctx.session))?.refs.find((r) => r.name === "OK")?.id;
    if (!ref) throw new Error("no OK ref in the snapshot");
    const t0 = Date.now();
    await cmdHistory(ctx, "reload");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SLOW_MS - 100);
    expect(await cmdEval(ctx, "performance.getEntriesByType('navigation')[0].type")).toBe("reload");
    await expect(cmdClick(ctx, ref)).rejects.toThrow(`ref '${ref}' is from a page that is no longer loaded; take a new snapshot`);
  }, 60_000);

  test("goto while a page script's navigation is still loading lands", async () => {
    await cmdGoto(ctx, `${base}/a`);
    await cmdEval(ctx, "setTimeout(() => location.href = '/slow', 0), 1");
    expect(await cmdGoto(ctx, `${base}/b`)).toBe(`navigated to ${base}/b`);
  }, 60_000);

  test("open with a URL while a page script's navigation is still loading lands", async () => {
    await cmdGoto(ctx, `${base}/a`);
    await cmdEval(ctx, "setTimeout(() => location.href = '/slow', 0), 1");
    expect(await cmdOpen(ctx, `${base}/b`)).toBe(`opened ${base}/b  "/b"`);
  }, 60_000);

  test("a reload that outlasts the budget says it was delivered, as an action's timeout does (#78)", async () => {
    await openDoc();
    const orig = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "1000";
    try {
      await expect(cmdHistory(ctx, "reload")).rejects.toThrow(
        "'reload' timed out after 1000ms waiting for the page it opened; the reload was delivered, check the page before retrying",
      );
    } finally {
      if (orig === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = orig;
    }
  }, 60_000);
});
