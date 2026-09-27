// End-to-end: a page whose web process has died is reported as crashed
// (spec 2026-09-27-p2-fixes-design.md, F34).
//
// There is no URL that crashes WebKit, so the test kills this session's own
// WebContent process: the one pid that appears across `open` (and, the second
// time, across the first crash's relaunch), checked to be a WebContent process
// started since the test began. Nothing else is touched; the test skips when
// the diff is not exactly one pid (another WebKit client started at the same
// moment).
//
// - The first kill: WebKit relaunches the process and reloads the page, which
//   nothing tells apart from a page reloading itself. Page state is gone and
//   nothing is reported.
// - The second kill: nothing reloads, and every page op fails with the
//   engine's dead-page message, which bowser reports as a crash (exit 2).
//   The page is not reloaded for you; `reload` recovers it.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-crash.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdHistory, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const WEB_CONTENT = "com.apple.WebKit.WebContent";
const CRASHED = "the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'";

/** Pids of every WebContent process now. */
function webContentPids(): Set<number> {
  const out = Bun.spawnSync(["pgrep", "-f", WEB_CONTENT]).stdout.toString();
  return new Set(out.split("\n").filter(Boolean).map(Number));
}

/** The one WebContent pid in `after` but not `before`, started at or after
 *  `sinceMs`; null when there is not exactly one. */
function newWebContent(before: Set<number>, after: Set<number>, sinceMs: number): number | null {
  const fresh = [...after].filter((p) => !before.has(p));
  if (fresh.length !== 1) return null;
  const pid = fresh[0]!;
  const ps = Bun.spawnSync(["ps", "-o", "lstart=,command=", "-p", String(pid)]).stdout.toString().trim();
  // lstart is "Sun Sep 27 09:52:52 2026", then the command.
  const m = ps.match(/^(\w{3} \w{3} +\d+ [\d:]{8} \d{4}) (.*)$/);
  if (!m || !m[2]!.includes(WEB_CONTENT)) return null;
  // lstart has one-second resolution.
  if (new Date(m[1]!).getTime() < sinceMs - 1000) return null;
  return pid;
}

/** Waits up to `ms` for exactly one new WebContent pid. */
async function waitForNew(before: Set<number>, sinceMs: number, ms = 5000): Promise<number | null> {
  const end = Date.now() + ms;
  for (;;) {
    const pid = newWebContent(before, webContentPids(), sinceMs);
    if (pid !== null || Date.now() > end) return pid;
    await Bun.sleep(100);
  }
}

/** Waits until `pid` has exited. */
async function waitForExit(pid: number, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(50);
  }
  throw new Error(`pid ${pid} did not exit`);
}

runOrSkip("e2e: a crashed page is reported as crashed", () => {
  const ctx: CommandContext = { session: `crash-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-crash-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(`<!doctype html><title>Crash</title><button>Go</button>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  test("the second crash fails the next op with the crash message (exit 2); reload recovers", async () => {
    const started = Date.now();
    const before = webContentPids();
    await cmdOpen(ctx, server!.url.toString());
    const first = await waitForNew(before, started);
    if (first === null) {
      console.warn("skipped: open did not start exactly one new WebContent process");
      return;
    }
    await cmdEval(ctx, "(window.mark = 7, 1)");

    // First crash: the engine relaunches the process and reloads the page.
    const afterOpen = webContentPids();
    process.kill(first, "SIGKILL");
    await waitForExit(first);
    await Bun.sleep(1500);
    expect(await cmdEval(ctx, "String(window.mark)")).toBe("undefined");
    const second = await waitForNew(afterOpen, started);
    if (second === null) {
      console.warn("skipped: the relaunch did not start exactly one new WebContent process");
      return;
    }

    // Second crash: nothing reloads, and every page op reports the crash.
    process.kill(second, "SIGKILL");
    await waitForExit(second);
    await Bun.sleep(1500);
    for (const op of [() => cmdEval(ctx, "location.href"), () => cmdSnapshot(ctx)]) {
      const err = await op().then((out) => { throw new Error(`expected a failure, got: ${out}`); }, (e: Error) => e);
      expect(err.message).toBe(CRASHED);
      expect(reportFailure(err).code).toBe(2);
    }
    // Not reloaded behind the user's back: it still fails.
    await expect(cmdEval(ctx, "1 + 1")).rejects.toThrow(CRASHED);

    await cmdHistory(ctx, "reload");
    expect(await cmdEval(ctx, "document.title")).toBe("Crash");
  }, 60_000);
});
