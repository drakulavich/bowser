// End-to-end: the longest session name bowser accepts under a long HOME opens
// a real session and closes it (F35). The limit there is Bun's 1016-byte path
// limit, which the daemon's pidfile claim (`<dir>/pid.<pid>.tmp`) meets first;
// measured on WebKit, Bun 1.4.2: one character more and the daemon died with
// ENAMETOOLONG, and `open` reported "did not start in time".
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-long-session.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { maxSessionNameLength, sessionsRoot } from "../src/state.ts";
import { longHome } from "./helpers/long-home.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: the longest session name for a long HOME", () => {
  let base: string;
  let origHome: string | undefined;
  let name: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    base = await mkdtemp(join(tmpdir(), "bowser-longname-"));
    // A sessions root of 850 characters puts the limit at 151, below 255.
    process.env.HOME = await longHome(base, 850);
    name = "n".repeat(maxSessionNameLength());
  });

  afterAll(async () => {
    try { await cmdClose({ session: name, json: false }); } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(base, { recursive: true, force: true });
  });

  test("the limit is below 255 here", () => {
    expect(maxSessionNameLength()).toBe(151);
  });

  test("a name at the limit opens, answers and closes", async () => {
    const ctx = { session: name, json: false };
    expect(await cmdOpen(ctx, "data:text/html,<title>long</title>")).toContain('"long"');
    expect(await cmdEval(ctx, "1 + 1")).toBe("2");
    expect(await cmdClose(ctx)).toBe(`closed session '${name}'`);
    expect(existsSync(join(sessionsRoot(), name))).toBe(false);
  });

  test("one character more is a usage error, and no session directory appears", async () => {
    const longer = name + "n";
    const err = await cmdOpen({ session: longer, json: false }, "data:text/html,x").catch((e) => e);
    expect(reportFailure(err).code).toBe(1);
    expect(existsSync(join(sessionsRoot(), longer))).toBe(false);
  });
});
