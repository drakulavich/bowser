// A command whose daemon dies mid-request must fail, not hang: the CLI seam of
// docs/superpowers/specs/2026-09-25-daemon-disconnect-design.md. Run with:
//   BOWSER_E2E=1 bun test tests/e2e-daemon-death.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { pidPath } from "../src/daemon/client.ts";

// Copied from the user-error check in src/cli.ts (the `import.meta.main`
// block); a match there means exit code 1 instead of 2.
const USER_ERROR = /^(usage:|unknown command|unknown flag|expected a ref|ref '.*' not found|no open page|bowser requires macOS)/i;

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: the daemon dies under a command", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: { stop: () => void } | undefined;
  let url: string;
  // Resolved when the page fetches /inflight, i.e. once the eval is running
  // inside the daemon. Killing earlier would let the command respawn a daemon.
  let markInflight: () => void = () => {};
  const inflight = new Promise<void>((r) => { markInflight = r; });

  const ctx: CommandContext = { session: "daemon-death", json: false };

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-daemon-death-"));
    process.env.HOME = tmp;
    const s = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/inflight") markInflight();
        return new Response("<h1>daemon death</h1>", { headers: { "content-type": "text/html" } });
      },
    });
    server = { stop: () => s.stop(true) };
    url = s.url.toString();
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("a command in flight fails when its daemon is killed", async () => {
    await cmdOpen(ctx, url);

    const evaluating = cmdEval(
      ctx,
      "fetch('/inflight').then(() => new Promise(r => setTimeout(() => r(1), 30000)))",
    );
    // Settle-only view of the command, so an early rejection is never unhandled.
    const outcome = evaluating.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
    );

    await inflight;
    const pid = Number((await Bun.file(pidPath(ctx.session)).text()).trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    process.kill(pid, "SIGKILL");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timed out">((r) => { timer = setTimeout(() => r("timed out"), 5000); });
    const settled = await Promise.race([outcome, bound]);
    clearTimeout(timer);

    expect(settled).not.toBe("timed out");
    if (settled === "timed out" || settled.ok) throw new Error(`eval did not fail: ${JSON.stringify(settled)}`);
    expect(settled.message).toContain(`daemon for session '${ctx.session}' closed the connection`);
    expect(USER_ERROR.test(settled.message)).toBe(false);
  }, 20_000);
});
