// Upgrade and lifecycle (P2 Task 1): the version check against a daemon from
// another bowser (F2), `close` of a silent daemon with no pidfile (F3), and
// how long `list` takes (F32). Every daemon here is a fake on the session's
// real socket, driven through `run()` or the CLI as its own process. No
// browser.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { reportFailure, run } from "../src/cli.ts";
import { socketPath } from "../src/daemon/client.ts";
import { ensureSessionDir, sessionDir } from "../src/state.ts";
import { daemonOf, fakeDaemon, SILENT } from "./helpers/fake-daemon.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-lifecycle-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

/** How `run(argv)` fails: the CLI's stderr line and exit code. */
async function failure(argv: string[]): Promise<{ stderr: string; code: number }> {
  try {
    const out = await run(argv);
    return { stderr: `no failure: ${out}`, code: 0 };
  } catch (err) {
    return reportFailure(err);
  }
}

describe("F2: a daemon from another bowser version", () => {
  const cases = [
    { label: "an old daemon (no version)", answer: "pong", v: "an older version" },
    { label: "a daemon of another version", answer: "0.6.1", v: "0.6.1" },
  ];

  for (const { label, answer, v } of cases) {
    test(`${label}: snapshot and open exit 1 and send nothing past ping`, async () => {
      const session = `ver-${answer.replaceAll(".", "")}`;
      const d = await fakeDaemon(session, daemonOf(answer));
      try {
        const expected = `bowser: session '${session}' is running bowser ${v} (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again`;
        expect(await failure(["snapshot", "-s", session])).toEqual({ stderr: expected, code: 1 });
        expect(await failure(["open", "https://example.com", "-s", session])).toEqual({ stderr: expected, code: 1 });
        expect(d.ops).toEqual(["ping", "ping"]);
      } finally {
        d.stop();
      }
    });

    test(`${label}: list lists it and close shuts it down`, async () => {
      const session = `verc-${answer.replaceAll(".", "")}`;
      const d = await fakeDaemon(session, daemonOf(answer));
      try {
        expect((await run(["list"])).split("\n")).toContain(session);
        expect(await run(["close", "-s", session])).toBe(`closed session '${session}'`);
        expect(d.ops).toContain("shutdown");
        expect(existsSync(sessionDir(session))).toBe(false);
      } finally {
        d.stop();
      }
    });
  }

  test("close --all shuts an old daemon down too", async () => {
    const session = "ver-all";
    const d = await fakeDaemon(session, daemonOf("pong"));
    try {
      expect(await run(["close", "--all"])).toContain(session);
      expect(d.ops).toContain("shutdown");
    } finally {
      d.stop();
    }
  });

  test("a daemon of this version is used as before", async () => {
    const session = "ver-same";
    const d = await fakeDaemon(session, daemonOf(pkg.version));
    try {
      expect(await run(["eval", "1", "-s", session])).toBe("1");
      expect(d.ops).toEqual(["ping", "evaluate"]);
    } finally {
      d.stop();
    }
  });
});

describe("F3: close of a silent daemon with no pidfile", () => {
  const message = (s: string) =>
    `close: session '${s}' has no pidfile (a daemon from bowser 0.5 or older) and its daemon did not answer; find it with 'pgrep -fl -- "--daemon ${s}"', end it, then run close again`;

  test("close exits 2 and keeps the session", async () => {
    const session = "silent3";
    const d = await fakeDaemon(session, () => SILENT);
    try {
      expect(await failure(["close", "-s", session])).toEqual({ stderr: `bowser: ${message(session)}`, code: 2 });
      expect(existsSync(socketPath(session))).toBe(true);
    } finally {
      d.stop();
      await rm(sessionDir(session), { recursive: true, force: true });
    }
  }, 10_000);

  test("close --all reports it as a failed session", async () => {
    const session = "silent3all";
    const d = await fakeDaemon(session, () => SILENT);
    try {
      const { stderr, code } = await failure(["close", "--all"]);
      expect(stderr).toContain(`- ${session}: ${message(session)}`);
      expect(code).toBe(2);
      expect(existsSync(sessionDir(session))).toBe(true);
    } finally {
      d.stop();
      await rm(sessionDir(session), { recursive: true, force: true });
    }
  }, 10_000);

  test("a socket with no listener is stale and is removed with success", async () => {
    const session = "stale3";
    await ensureSessionDir(session);
    // A unix socket file nobody listens on: connect is refused.
    const bound = Bun.spawnSync([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath(session))}, () => process.kill(process.pid, "SIGKILL"))`]);
    expect(bound.exitCode).not.toBe(0);
    expect(existsSync(socketPath(session))).toBe(true);
    expect(await run(["close", "-s", session])).toBe(`closed session '${session}'`);
    expect(existsSync(sessionDir(session))).toBe(false);
  });
});

describe("F32: list", () => {
  /** `bowser list` as its own process: its stdout and wall time. */
  async function timedList(): Promise<{ out: string; ms: number }> {
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, CLI, "list"], { env: { ...process.env, HOME: tmp }, stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { out, ms: performance.now() - started };
  }

  test("with a live session, exits as soon as it has printed", async () => {
    const d = await fakeDaemon("live32", daemonOf(pkg.version));
    try {
      await timedList(); // warm the module cache
      const { out, ms } = await timedList();
      expect(out.split("\n")).toContain("live32");
      expect(ms).toBeLessThan(500);
    } finally {
      d.stop();
      await rm(sessionDir("live32"), { recursive: true, force: true });
    }
  }, 10_000);

  test("a daemon that never answers is not listed, within the probe bound", async () => {
    const d = await fakeDaemon("mute32", () => SILENT);
    try {
      const { out, ms } = await timedList();
      expect(out.split("\n")).not.toContain("mute32");
      expect(ms).toBeLessThan(1800);
    } finally {
      d.stop();
      await rm(sessionDir("mute32"), { recursive: true, force: true });
    }
  }, 10_000);
});
