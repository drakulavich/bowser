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
