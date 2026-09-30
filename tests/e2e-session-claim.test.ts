// Sessions on WebKit: one daemon per session however many first commands
// race to start it (F29), and what a command does after the session's
// browser died (F28). Spec: docs/superpowers/specs/2026-09-27-p1-fixes-design.md,
// "Task 4: Sessions". Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-session-claim.test.ts

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { connectOrSpawn, pidPath, socketPath } from "../src/daemon/client.ts";
import { ensureSessionDir, profileDir, sessionDir } from "../src/state.ts";
import { daemonPids, killDaemons, waitFor } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function storedOnDisk(profile: string, key: string): boolean {
  for (const f of new Bun.Glob("Origins/*/*/LocalStorage/localstorage.sqlite3").scanSync(profile)) {
    try {
      const db = new Database(join(profile, f), { readonly: true });
      try {
        if (db.query("SELECT 1 FROM ItemTable WHERE key = ?").get(key)) return true;
      } finally {
        db.close();
      }
    } catch {}
  }
  return false;
}

runOrSkip("e2e: sessions (F28, F29)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  const sessions: string[] = [];
  const session = (name: string): string => {
    const s = `${name}-${process.pid}`;
    sessions.push(s);
    return s;
  };

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-session-claim-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`<title>claim</title><p>${new URL(req.url).pathname}</p>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });
    url = server.url.toString();
  });

  afterAll(async () => {
    for (const s of sessions) {
      try { await cmdClose({ session: s, json: true }); } catch {}
      // Only the daemons of this file's own sessions, never a broad pattern.
      await killDaemons(s);
    }
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("F29: five concurrent opens on a new session leave one daemon, and none after close", async () => {
    const s = session("race5");
    const procs = [1, 2, 3, 4, 5].map((i) => Bun.spawn(
      [process.execPath, CLI, `-s=${s}`, "open", `${url}?i=${i}`],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    ));
    const codes = await Promise.all(procs.map((p) => p.exited));
    // Let a losing daemon that is still starting finish its exit, and a
    // second winner (the bug) finish its start, before counting.
    await Bun.sleep(1500);
    const pids = await daemonPids(s);
    expect(pids.length).toBe(1);
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    // The pidfile names the one daemon.
    expect(Number((await Bun.file(pidPath(s)).text()).trim())).toBe(pids[0]!);

    await cmdClose({ session: s, json: true });
    expect(await waitFor(async () => (await daemonPids(s)).length === 0)).toBe(true);
  }, 60_000);
  test("F28: after kill -9, a persistent session refuses every command but open and close", async () => {
    const s = session("crash28");
    const ctx: CommandContext = { session: s, json: false };
    await cmdOpen(ctx, url, { persistent: true });
    await cmdEval(ctx, "(localStorage.setItem('pre', '1'), 1)");
    // WebKit commits localStorage ~500 ms after a write; a kill before that loses it (#87).
    expect(await waitFor(() => storedOnDisk(profileDir(s), "pre"))).toBe(true);
    const pid = Number((await Bun.file(pidPath(s)).text()).trim());
    process.kill(pid, "SIGKILL");
    expect(await waitFor(async () => (await daemonPids(s)).length === 0)).toBe(true);

    // The next command fails, a user error, and starts no browser.
    for (const attempt of [() => cmdGoto(ctx, `${url}two`), () => cmdEval(ctx, "localStorage.getItem('pre')")]) {
      const err = await attempt().then(() => undefined, (e: unknown) => e);
      expect((err as Error)?.message).toBe(`session '${s}' is not open (its browser exited); run 'bowser open'`);
      expect(reportFailure(err).code).toBe(1);
    }
    expect(await daemonPids(s)).toEqual([]);

    // open starts it again, on the same profile: what the session stored before the crash is there.
    await cmdOpen(ctx, url, { persistent: true });
    expect(await cmdEval(ctx, "localStorage.getItem('pre')")).toBe("1");
    expect((await daemonPids(s)).length).toBe(1);
  }, 60_000);

  test("F28: close after a crash clears the session; the next first command starts a browser", async () => {
    const s = session("crash28c");
    const ctx: CommandContext = { session: s, json: false };
    await cmdOpen(ctx, url);
    process.kill(Number((await Bun.file(pidPath(s)).text()).trim()), "SIGKILL");
    expect(await waitFor(async () => (await daemonPids(s)).length === 0)).toBe(true);

    expect(await cmdClose(ctx)).toBe(`closed session '${s}'`);
    expect(existsSync(sessionDir(s))).toBe(false);
    expect(await cmdGoto(ctx, url)).toBe(`navigated to ${url}`);
    expect((await daemonPids(s)).length).toBe(1);
  }, 60_000);
});

// F29 through the real daemon entry (src/daemon/main.ts): a daemon that wins
// the claim opens a WebKit view. The claim's own races are unit-tested in
// tests/daemon.test.ts through claimSession.
runOrSkip("e2e: daemon session claim (F29)", () => {
  const MAIN = join(import.meta.dir, "..", "src", "daemon", "main.ts");
  let tmp: string;
  let origHome: string | undefined;
  const sessions: string[] = [];
  const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-claim-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    for (const p of spawned) p.kill("SIGKILL");
    for (const s of sessions) await killDaemons(s);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const fresh = async (name: string): Promise<string> => {
    const s = `${name}-${process.pid}`;
    sessions.push(s);
    await ensureSessionDir(s);
    return s;
  };
  const startDaemonProc = (session: string) => {
    const p = Bun.spawn([process.execPath, MAIN, session], {
      env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    spawned.push(p);
    return p;
  };
  const exitedWithin = (p: ReturnType<typeof Bun.spawn>, ms: number) =>
    Promise.race([p.exited, Bun.sleep(ms).then(() => "running" as const)]);

  test("a daemon starting on a session a live daemon of ours holds exits, leaving its socket and pidfile", async () => {
    const session = await fresh("held");
    // Stands in for the running daemon: `ps` shows it exactly as it shows ours.
    const holder = Bun.spawn(
      [process.execPath, "-e", "setInterval(()=>{},1e9)", "/x/src/daemon/main.ts", session],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    spawned.push(holder);
    await waitFor(async () => (await daemonPids(session)).includes(holder.pid));
    await Bun.write(pidPath(session), String(holder.pid));
    const listener = Bun.listen({ unix: socketPath(session), socket: { data() {} } });
    try {
      const newcomer = startDaemonProc(session);
      expect(await exitedWithin(newcomer, 5000)).toBe(0);
      expect((await Bun.file(pidPath(session)).text()).trim()).toBe(String(holder.pid));
      expect(existsSync(socketPath(session))).toBe(true);
    } finally {
      listener.stop(true);
      holder.kill("SIGKILL");
    }
  }, 15_000);

  for (const stale of [false, true]) {
    test(`five daemons starting on one session${stale ? " with a stale pidfile" : ""} leave one listening daemon and its pidfile`, async () => {
      const session = await fresh(stale ? "stale5" : "race5u");
      // A pid that is no process (the largest pid macOS hands out is 99998).
      if (stale) await Bun.write(pidPath(session), "99999");
      const procs = [1, 2, 3, 4, 5].map(() => startDaemonProc(session));
      // Every loser exits on its own; the winner stays.
      expect(await waitFor(() => procs.filter((p) => p.exitCode === null).length <= 1, 10_000)).toBe(true);
      await Bun.sleep(500);
      const pids = await daemonPids(session);
      expect(pids.length).toBe(1);
      expect(Number((await Bun.file(pidPath(session)).text()).trim())).toBe(pids[0]!);
      const c = await connectOrSpawn(session, { spawn: false });
      try {
        await c.request("shutdown");
      } finally {
        c.close();
      }
      expect(await waitFor(async () => (await daemonPids(session)).length === 0)).toBe(true);
    }, 30_000);
  }
});
