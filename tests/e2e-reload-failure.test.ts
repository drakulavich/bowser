// End-to-end (#123): `reload` of a page whose server has gone fails with
// WebKit's reason, as `goto` does, instead of answering `reloaded <url>`.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-reload-failure.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: reload of a page whose server is down (#123)", () => {
  const ctx: CommandContext = { session: "reloadfail", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-reloadfail-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`<!doctype html><title>${new URL(req.url).pathname}</title>`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: Error) => e);

  test("reload fails with the connection failure, exit 2, as goto does", async () => {
    await cmdOpen(ctx, `${base}/doc`);
    server?.stop(true);
    const reloadErr = await failure(cmdHistory(ctx, "reload"));
    const gotoErr = await failure(cmdGoto(ctx, `${base}/doc`));
    expect(reportFailure(reloadErr)).toEqual({ stderr: "bowser: Could not connect to the server.", code: 2 });
    expect(reportFailure(gotoErr)).toEqual(reportFailure(reloadErr));
  }, 60_000);
});

// #127: the same for go-back and go-forward, once the history is deeper than
// WebKit's back-forward cache, which serves the nearest pages without the server.
runOrSkip("e2e: go-back and go-forward to a page whose server is down (#127)", () => {
  const ctx: CommandContext = { session: "historyfail", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-historyfail-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`<!doctype html><title>${new URL(req.url).pathname}</title>`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const outcome = (p: Promise<string>) => p.then((text) => text, (e: Error) => reportFailure(e).stderr);

  test("a back or forward that answers has moved; the one that cannot load fails with the reason", async () => {
    await cmdOpen(ctx, `${base}/p0`);
    for (let i = 1; i <= 15; i++) await cmdGoto(ctx, `${base}/p${i}`);
    server?.stop(true);
    const backs: string[] = [];
    for (let i = 0; i < 15; i++) backs.push(await outcome(cmdHistory(ctx, "back")));
    const forward = await outcome(cmdHistory(ctx, "forward"));
    const answered = backs.filter((b) => b.startsWith("back -> "));
    expect(new Set(answered).size).toBe(answered.length);
    expect(backs).toContain("bowser: Could not connect to the server.");
    expect(forward).toBe("bowser: Could not connect to the server.");
  }, 120_000);
});
