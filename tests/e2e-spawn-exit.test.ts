// A daemon-spawning command returns to the shell (F7). Bun holds the parent's
// event loop open until a spawned child exits, and the daemon never exits, so
// `spawnDaemon` must `proc.unref()` it. `bun test` masks a missing unref (the
// runner force-exits), so this runs the CLI as its own process. Measured
// without unref: `bun src/cli.ts open <url>` printed `opened …` and hung.
// Spec: docs/superpowers/specs/2026-09-27-p2-fixes-design.md, "Task 4". Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-spawn-exit.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClose } from "../src/commands/navigation.ts";
import { killDaemons } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const BOUND_MS = 20_000;

runOrSkip("e2e: a daemon-spawning command exits (F7)", () => {
  let tmp: string;
  let origHome: string | undefined;
  const session = `spawn-exit-${process.pid}`;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-spawn-exit-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    try { await cmdClose({ session, json: true }); } catch {}
    await killDaemons(session);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("`open` on a new session prints its answer and exits", async () => {
    const proc = Bun.spawn(
      [process.execPath, CLI, `-s=${session}`, "open", "data:text/html,<title>spawn</title><h1>x</h1>"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const started = Date.now();
    const timer = setTimeout(() => proc.kill("SIGKILL"), BOUND_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("spawn");
    expect(proc.signalCode).toBeNull();
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  }, BOUND_MS + 10_000);
});
