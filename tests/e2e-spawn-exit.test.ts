// A daemon-spawning command returns to the shell (F7). Bun holds the parent's
// event loop open until a spawned child exits, and the daemon never exits, so
// `spawnDaemon` must `proc.unref()` it. `bun test` masks a missing unref (the
// runner force-exits), so this runs the CLI as its own process. Measured
// without unref: `bun src/cli.ts open <url>` printed `opened …` and hung.
// Spec: docs/superpowers/specs/2026-09-27-p2-fixes-design.md, "Task 4". Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-spawn-exit.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClose } from "../src/commands/navigation.ts";
import { daemonLogPath } from "../src/daemon/client.ts";
import { sessionDir } from "../src/state.ts";
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

// F6: with BOWSER_DAEMON_DEBUG=1 the daemon used to inherit the caller's
// stdout and stderr. It outlives the command, so a reader of a pipe
// (`| cat`, `$(…)`, an agent's shell tool) never saw EOF. Its output now
// goes to daemon.log in the session directory. Spec:
// docs/superpowers/specs/2026-09-28-p3-fixes-design.md, "F6".
runOrSkip("e2e: BOWSER_DAEMON_DEBUG writes the daemon's output to a log, never to the caller's pipe (F6)", () => {
  let tmp: string;
  let origHome: string | undefined;
  const ok = `debug-pipe-${process.pid}`;
  const broken = `debug-broken-${process.pid}`;
  const EOF_MS = 10_000;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-debug-log-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    for (const session of [ok, broken]) {
      try { await cmdClose({ session, json: true }); } catch {}
      await killDaemons(session);
    }
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** Run the CLI with debug on and read its stdout and stderr to EOF, or
   *  give up at EOF_MS: a daemon holding the pipe keeps EOF away. */
  const runPiped = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
      env: { ...process.env, BOWSER_DAEMON_DEBUG: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const both = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const timeout = Bun.sleep(EOF_MS).then(() => "no EOF" as const);
    const got = await Promise.race([both, timeout]);
    if (got === "no EOF") proc.kill("SIGKILL");
    return got;
  };

  test("a piped `open` that spawns the daemon reaches EOF", async () => {
    const got = await runPiped([`-s=${ok}`, "open", "data:text/html,<title>debug</title><h1>x</h1>"]);
    expect(got).not.toBe("no EOF");
    const [out, , code] = got as [string, string, number];
    expect(out).toContain("debug");
    expect(code).toBe(0);
  }, EOF_MS + 10_000);

  test("a daemon that fails to start leaves its error in daemon.log, and the CLI names the file", async () => {
    // A directory where the socket goes: the daemon's listen fails.
    await mkdir(join(sessionDir(broken), "sock", "x"), { recursive: true });
    const got = await runPiped([`-s=${broken}`, "open", "data:text/html,x"]);
    expect(got).not.toBe("no EOF");
    const [, err, code] = got as [string, string, number];
    expect(code).toBe(2);
    expect(err).toContain(`did not start in time; its output is in ${daemonLogPath(broken)}`);
    expect(await Bun.file(daemonLogPath(broken)).text()).toContain("EADDRINUSE");
  }, EOF_MS + 10_000);
});
