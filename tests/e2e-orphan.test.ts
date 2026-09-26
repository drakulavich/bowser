// The process leak, turned into a test: a daemon whose socket has gone must
// not survive `close`.
//
// This is the reproduction from
// docs/superpowers/specs/2026-09-06-session-liveness-design.md — `close` used
// to connect, swallow the failure, unlink the socket and report success, and
// the running daemon was left holding a browser view that no command could
// reach. Needs a real browser, so it is guarded like the other e2e files:
//
//   BOWSER_E2E=1 bun test tests/e2e-orphan.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { pidPath, socketPath } from "../src/daemon/client.ts";
import { sessionDir } from "../src/state.ts";

const runOrSkip = process.env.BOWSER_E2E === "1" ? describe : describe.skip;

runOrSkip("e2e: an unreachable daemon does not survive close", () => {
  let tmp: string;
  let origHome: string | undefined;
  const session = "orphan";

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-orphan-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    try { await cmdClose({ session, json: true }); } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  test("close ends a daemon whose socket is gone", async () => {
    await cmdOpen({ session, json: true });
    const pid = Number((await readFile(pidPath(session), "utf8")).trim());
    expect(alive(pid)).toBe(true);

    // The reproduction: the daemon is running, and nothing can reach it.
    await unlink(socketPath(session));

    const out = await cmdClose({ session, json: false });
    expect(out).toContain(`ended unreachable daemon ${pid}`);

    // The point of the whole ticket: no browser left running behind a report
    // of success. SIGTERM is asynchronous, so give the exit a moment.
    for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
    expect(existsSync(sessionDir(session))).toBe(false);
  }, 120_000);
});
