// End-to-end: bowser installed under a path with a space, # or % starts its
// daemon (#150). Spec: docs/superpowers/specs/2026-10-14-install-path-design.md.
// Run with:
//
//   BOWSER_E2E=1 bun test ./tests/e2e-install-path.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonPids, killDaemons } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const ROOT = join(import.meta.dir, "..");

interface Result { code: number; out: string; err: string }

runOrSkip("e2e: installed under a path with a space, # or % (#150)", () => {
  let tmp: string;
  let home: string;
  let dir: string;
  const session = `ip-${process.pid}`;

  async function run(args: string[]): Promise<Result> {
    const proc = Bun.spawn([process.execPath, join(dir, "src", "cli.ts"), `-s=${session}`, ...args], {
      env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out: out.trim(), err: err.trim() };
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "bowser-install-path-"));
    home = join(tmp, "home");
    await mkdir(home);
    dir = join(tmp, "in st#all%20");
    await cp(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    await cp(join(ROOT, "package.json"), join(dir, "package.json"));
  });

  afterAll(async () => {
    await killDaemons(session);
    await rm(tmp, { recursive: true, force: true });
  });

  test("open, list and close work from the copy", async () => {
    const open = await run(["open", "data:text/html,<title>ip</title>"]);
    expect(open.code).toBe(0);
    expect(open.out).toContain("ip");

    const pids = await daemonPids(session);
    expect(pids).toHaveLength(1);
    const ps = Bun.spawn(["ps", "-o", "command=", "-p", String(pids[0])], { stdout: "pipe" });
    expect(await new Response(ps.stdout).text()).toContain(join(dir, "src", "daemon", "main.ts"));

    const list = await run(["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain(session);

    const close = await run(["close"]);
    expect(close.code).toBe(0);
    expect(await daemonPids(session)).toHaveLength(0);
  }, 60_000);
});
