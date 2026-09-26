// End-to-end: `open --persistent` / `open --profile=<dir>` keep cookies and
// localStorage across `close` and a fresh daemon; without either flag they are
// gone. Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-persistent.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen, type OpenOptions } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { sessionDir } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

// A persistent cookie (max-age): a session cookie is not restored by design.
const WRITE = `(localStorage.setItem('k', 'v'), document.cookie = 'c=1; max-age=3600', 'written')`;
const READ = `JSON.stringify({ ls: localStorage.getItem('k'), cookie: document.cookie })`;

runOrSkip("e2e: persistent profile survives close", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let page: string;
  const sessions = ["e2e-persist", "e2e-ephemeral", "e2e-profile"];

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-persist-e2e-"));
    process.env.HOME = tmp;
    // A real http origin: data: URLs have no localStorage and no cookies.
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("<html><head><title>Persist</title></head><body>p</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    page = server.url.toString();
  });

  afterAll(async () => {
    for (const session of sessions) {
      try { await cmdClose({ session, json: true }); } catch {}
    }
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    // Holds the profiles too: HOME, and every --profile dir, are under it.
    await rm(tmp, { recursive: true, force: true });
  });

  /** Write a cookie and a localStorage item, close, open again with the same
   *  options, and read both back. */
  async function roundTrip(session: string, opts: OpenOptions): Promise<{ ls: string | null; cookie: string }> {
    const ctx: CommandContext = { session, json: true };
    await cmdOpen(ctx, page, opts);
    expect(JSON.parse(await cmdEval(ctx, WRITE)).result).toBe("written");
    await cmdClose(ctx);
    expect(existsSync(sessionDir(session))).toBe(false);
    await cmdOpen(ctx, page, opts);
    const read = JSON.parse(JSON.parse(await cmdEval(ctx, READ)).result as string);
    await cmdClose(ctx);
    return read;
  }

  test("--persistent keeps cookies and localStorage in ~/.bowser/profiles/<session>", async () => {
    const got = await roundTrip("e2e-persist", { persistent: true });
    expect(got).toEqual({ ls: "v", cookie: "c=1" });
    const profile = join(tmp, ".bowser", "profiles", "e2e-persist");
    expect(readdirSync(profile).length).toBeGreaterThan(0);
  }, 60_000);

  test("without a flag both are gone after close", async () => {
    const got = await roundTrip("e2e-ephemeral", {});
    expect(got).toEqual({ ls: null, cookie: "" });
    expect(existsSync(join(tmp, ".bowser", "profiles", "e2e-ephemeral"))).toBe(false);
  }, 60_000);

  test("--profile=<dir> keeps both in that directory", async () => {
    const dir = join(tmp, "custom-profile");
    const got = await roundTrip("e2e-profile", { profile: dir });
    expect(got).toEqual({ ls: "v", cookie: "c=1" });
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, ".bowser", "profiles", "e2e-profile"))).toBe(false);
  }, 60_000);
});
