// End-to-end: `state-save` on a fresh session's about:blank writes an empty
// storageState, as playwright-cli does. WebKit refuses a localStorage read
// there ("The operation is insecure"), so only a real page shows it (F33).
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-state-blank.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdStateSave } from "../src/commands/storage-state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: state-save on about:blank", () => {
  const ctx: CommandContext = { session: "stateblank", json: true };
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-stateblank-"));
    process.env.HOME = tmp;
    await cmdOpen(ctx);
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("writes {cookies: [], origins: []} and reports 0 origins", async () => {
    const file = join(tmp, "blank.json");
    expect(JSON.parse(await cmdStateSave(ctx, file))).toEqual({ ok: true, file, origins: 0 });
    expect(await Bun.file(file).json()).toEqual({ cookies: [], origins: [] });
  });
});
