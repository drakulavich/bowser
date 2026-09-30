// Upgrade and lifecycle (P2 Task 1): the version check against a daemon from
// another bowser (F2), `close` of a silent daemon with no pidfile (F3), how
// long `list` takes (F32), and a timeout that names the command (F21). Every
// daemon here is a fake on the session's real socket, driven through `run()`
// or the CLI as its own process. No browser.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { reportFailure, run } from "../src/cli.ts";
import { connectOrSpawn, socketPath } from "../src/daemon/client.ts";
import type { DaemonRequest, DaemonResponse } from "../src/daemon/protocol.ts";
import { dispatch } from "../src/daemon/server.ts";
import { createSerializer } from "../src/serialize.ts";
import { ensureSessionDir, profileDir, saveState, sessionDir } from "../src/state.ts";
import { daemonOf, fakeDaemon, lineSocket, SILENT } from "./helpers/fake-daemon.ts";

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

  test("a session with a persistent profile on disk is told to open it with --persistent (#79)", async () => {
    const session = "ver-persistent";
    await mkdir(profileDir(session), { recursive: true });
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    try {
      expect(await failure(["snapshot", "-s", session])).toEqual({
        stderr: `bowser: session '${session}' is running bowser 0.6.1 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again with 'bowser open --persistent'`,
        code: 1,
      });
    } finally {
      d.stop();
    }
  });

  test("a session whose open recorded a custom profile is told to open it with --profile (#93)", async () => {
    const session = "ver-custom";
    const dir = join(tmp, "custom-profile");
    await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: dir });
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    try {
      expect((await failure(["snapshot", "-s", session])).stderr).toBe(
        `bowser: session '${session}' is running bowser 0.6.1 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again with 'bowser open --profile=${dir}'`,
      );
    } finally {
      d.stop();
    }
  });

  describe("a process older than the installed bowser (#79)", () => {
    const installed = "99.0.0";
    const refusal = (session: string, installedVersion: () => Promise<string | undefined>) =>
      connectOrSpawn(session, { installedVersion }).then(() => "no refusal", (e: unknown) => (e as Error).message);

    test("a daemon of the installed version: restart this process", async () => {
      const session = "ver-stale-proc";
      const d = await fakeDaemon(session, daemonOf(installed));
      try {
        expect(await refusal(session, async () => installed)).toBe(
          `this bowser (${pkg.version}) is older than the installed bowser (${installed}); restart the MCP server or re-run the command`,
        );
      } finally {
        d.stop();
      }
    });

    test("a daemon of neither version, or no package.json on disk: close and open again", async () => {
      const session = "ver-stale-other";
      const d = await fakeDaemon(session, daemonOf("0.6.1"));
      const closeAndOpen = `session '${session}' is running bowser 0.6.1 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again`;
      try {
        expect(await refusal(session, async () => installed)).toBe(closeAndOpen);
        expect(await refusal(session, async () => undefined)).toBe(closeAndOpen);
      } finally {
        d.stop();
      }
    });
  });

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

describe("F21: a timeout names the command", () => {
  /** A daemon on the real dispatcher with a 50 ms budget, whose `click`
   *  never settles. */
  async function stuckClickDaemon(session: string) {
    await ensureSessionDir(session);
    const serialize = createSerializer();
    const handle = async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.op === "ping") return { id: req.id, ok: true, result: pkg.version };
      if (req.op === "evaluate") return { id: req.id, ok: true, result: "#x" };
      if (req.op === "click") return new Promise(() => {});
      return { id: req.id, ok: true };
    };
    return Bun.listen({
      unix: socketPath(session),
      socket: lineSocket((s, line) => {
        dispatch(JSON.parse(line) as DaemonRequest, {
          handle, serialize, timeoutMs: 50,
          reply: (res) => { s.write(JSON.stringify(res) + "\n"); },
        });
      }),
    });
  }

  async function seed(session: string) {
    await saveState({
      name: session, url: "https://x", title: "X", updatedAt: 1,
      refs: [{ id: "e2", role: "textbox", name: "Under", tag: "input" }],
    });
  }

  test("fill names itself and its click step", async () => {
    const session = "t21fill";
    const server = await stuckClickDaemon(session);
    await seed(session);
    try {
      expect(await failure(["fill", "e2", "hi", "-s", session])).toEqual({
        stderr: "bowser: 'fill' timed out after 50ms (in its 'click' step)",
        code: 2,
      });
    } finally {
      server.stop(true);
    }
  });

  test("click prints no step", async () => {
    const session = "t21click";
    const server = await stuckClickDaemon(session);
    await seed(session);
    try {
      expect(await failure(["click", "e2", "-s", session])).toEqual({
        stderr: "bowser: 'click' timed out after 50ms",
        code: 2,
      });
    } finally {
      server.stop(true);
    }
  });
});
