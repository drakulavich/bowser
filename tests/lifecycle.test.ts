// Upgrade and lifecycle (P2 Task 1): the version check against a daemon from
// another bowser (F2), `close` of a silent daemon with no pidfile (F3), how
// long `list` takes (F32), and a timeout that names the command (F21). Every
// daemon here is a fake on the session's real socket, driven through `run()`
// or the CLI as its own process. No browser.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { reportFailure, run } from "../src/cli.ts";
import { connectOrSpawn, socketPath, type ConnectOptions } from "../src/daemon/client.ts";
import type { DaemonRequest, DaemonResponse } from "../src/daemon/protocol.ts";
import { dispatch } from "../src/daemon/server.ts";
import { createSerializer } from "../src/serialize.ts";
import { ensureSessionDir, loadState, profileDir, saveState, sessionDir } from "../src/state.ts";
import { daemonOf, fakeDaemon, lineSocket, SILENT, type FakeDaemon } from "./helpers/fake-daemon.ts";

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

/** An older daemon on the session's socket that stops on `shutdown`, and the
 *  connector a restart reconnects through: once the old one is down, it puts
 *  a daemon of this version on the socket, answering `state` with `url` and
 *  `profile`, as a spawned one would. */
async function upgrade(session: string, answer: string, page: { url?: string; profile?: string }) {
  const url = page.url ?? "about:blank";
  let next: FakeDaemon | undefined;
  const old: FakeDaemon = await fakeDaemon(session, (req) => {
    if (req.op === "shutdown") queueMicrotask(() => old.stop());
    return daemonOf(answer)(req);
  });
  const current = (req: { op: string }) =>
    req.op === "state" ? { url, title: "", profile: page.profile } : daemonOf(pkg.version)(req as Parameters<ReturnType<typeof daemonOf>>[0]);
  const connect = async (s: string, o?: ConnectOptions) => {
    if (old.ops.includes("shutdown") && !next) next = await fakeDaemon(session, current);
    return connectOrSpawn(s, o);
  };
  return { old, next: () => next, connect, stop: () => { old.stop(); next?.stop(); } };
}

describe("F2: a daemon from another bowser version", () => {
  const cases = [
    { label: "an old daemon (no version)", answer: "pong", v: "an older version" },
    { label: "a daemon of another version", answer: "0.6.1", v: "0.6.1" },
  ];

  for (const { label, answer, v } of cases) {
    test(`${label}: restarts an older daemon and says what was lost`, async () => {
      const session = `ver-${answer.replaceAll(".", "")}`;
      await saveState({ name: session, url: "https://example.com/cart", title: "Cart", refs: [], updatedAt: 0, profile: null });
      const up = await upgrade(session, answer, { url: "https://example.com/cart" });
      try {
        const notices: string[] = [];
        expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
        expect(notices).toEqual([
          `session '${session}' restarted for bowser ${pkg.version} (was ${v}): page reloaded at https://example.com/cart; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`,
        ]);
        expect(up.old.ops.filter((op) => op !== "ping")).toEqual(["shutdown"]);
        expect(up.next()?.ops).toContain("navigate");
        expect(existsSync(join(sessionDir(session), "upg"))).toBe(false);
      } finally {
        up.stop();
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

  test("restarts an older daemon: a persistent profile on disk is kept (#79)", async () => {
    const session = "ver-persistent";
    await mkdir(profileDir(session), { recursive: true });
    const up = await upgrade(session, "0.6.1", { profile: profileDir(session) });
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
      expect(notices).toEqual([
        `session '${session}' restarted for bowser ${pkg.version} (was 0.6.1): no page was open; refs cleared, run 'bowser snapshot'`,
      ]);
      expect((await loadState(session))?.profile).toBe(profileDir(session));
    } finally {
      up.stop();
    }
  });

  test("restarts an older daemon: a custom profile is kept across two upgrades (#93)", async () => {
    const session = "ver-custom";
    const dir = join(tmp, "custom-profile");
    await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: dir });
    for (const old of ["0.6.1", "0.6.2"]) {
      const up = await upgrade(session, old, { profile: dir });
      try {
        const notices: string[] = [];
        expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
        expect(notices[0]).not.toContain("cookies and storage were lost");
        expect((await loadState(session))?.profile).toBe(dir);
      } finally {
        up.stop();
      }
    }
  });

  test("a newer daemon is still refused, and nothing past ping is sent", async () => {
    const session = "ver-newer";
    const d = await fakeDaemon(session, daemonOf("99.0.0"));
    try {
      expect(await failure(["snapshot", "-s", session])).toEqual({
        stderr: `bowser: session '${session}' is running bowser 99.0.0 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again`,
        code: 1,
      });
      expect(d.ops).toEqual(["ping"]);
    } finally {
      d.stop();
    }
  });

  test("with no package.json on disk, an older daemon is still refused", async () => {
    const session = "ver-noinstall";
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    const connect = (s: string, o?: ConnectOptions) => connectOrSpawn(s, { ...o, installedVersion: async () => undefined });
    try {
      const err = await run(["snapshot", "-s", session], { connect }).then(() => undefined, (e: unknown) => e);
      expect(reportFailure(err).stderr).toBe(
        `bowser: session '${session}' is running bowser 0.6.1 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again`,
      );
      expect(d.ops).toEqual(["ping"]);
    } finally {
      d.stop();
    }
  });

  test("restart lock: a dead holder's lock is taken", async () => {
    const session = "ver-deadlock";
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await ensureSessionDir(session);
    await Bun.write(join(sessionDir(session), "upg"), String(dead.pid));
    const up = await upgrade(session, "0.6.1", {});
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
      expect(notices).toHaveLength(1);
      expect(existsSync(join(sessionDir(session), "upg"))).toBe(false);
    } finally {
      up.stop();
    }
  });

  test("restart lock: a live holder is waited for, and the daemon it started is used", async () => {
    const session = "ver-livelock";
    await ensureSessionDir(session);
    const lock = join(sessionDir(session), "upg");
    await Bun.write(lock, String(process.ppid));
    const old = await fakeDaemon(session, daemonOf("0.6.1"));
    let next: FakeDaemon | undefined;
    setTimeout(async () => {
      old.stop();
      await unlink(socketPath(session)).catch(() => {});
      next = await fakeDaemon(session, daemonOf(pkg.version));
      await unlink(lock);
    }, 300);
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { notices })).toBe("1");
      expect(notices).toEqual([]);
      expect(old.ops).not.toContain("shutdown");
    } finally {
      old.stop();
      next?.stop();
    }
  });

  test("restart lock: a holder that outlasts the budget fails the command and leaves the daemon alone", async () => {
    const session = "ver-heldlock";
    await ensureSessionDir(session);
    const lock = join(sessionDir(session), "upg");
    await Bun.write(lock, String(process.ppid));
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "300";
    try {
      expect(await failure(["eval", "1", "-s", session])).toEqual({
        stderr: `bowser: session '${session}' is being restarted by pid ${process.ppid} (${lock})`,
        code: 1,
      });
      expect(d.ops).not.toContain("shutdown");
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
      d.stop();
    }
  });

  describe("a process whose version differs from the installed bowser (#79)", () => {
    const refusal = (session: string, installedVersion: () => Promise<string | undefined>) =>
      connectOrSpawn(session, { installedVersion }).then(() => "no refusal", (e: unknown) => (e as Error).message);

    for (const [label, installed] of [["an upgrade", "99.0.0"], ["a downgrade", "0.0.1"]] as const) {
      test(`${label}: a daemon of the installed version: restart this process`, async () => {
        const session = `ver-stale-${installed.replaceAll(".", "")}`;
        const d = await fakeDaemon(session, daemonOf(installed));
        try {
          expect(await refusal(session, async () => installed)).toBe(
            `this bowser (${pkg.version}) differs from the installed bowser (${installed}); restart the MCP server or re-run the command`,
          );
        } finally {
          d.stop();
        }
      });
    }

    test("a daemon of neither version, or no package.json on disk: close and open again", async () => {
      const installed = "99.0.0";
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
      if (req.op === "resolve" || req.op === "evaluate") return { id: req.id, ok: true, result: "#x" };
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
