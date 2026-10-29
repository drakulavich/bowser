// Upgrade and lifecycle (P2 Task 1): the version check against a daemon from
// another bowser (F2), `close` of a silent daemon with no pidfile (F3), how
// long `list` takes (F32), and a timeout that names the command (F21). Every
// daemon here is a fake on the session's real socket, driven through `run()`
// or the CLI as its own process. No browser.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { reportFailure, run } from "../src/cli.ts";
import { connectOrSpawn, NoDaemon, OlderDaemon, socketPath, type ConnectOptions } from "../src/daemon/client.ts";
import { claimSession, isBowser } from "../src/daemon/pidfile.ts";
import { closeOne } from "../src/commands/navigation.ts";
import { restartSession } from "../src/commands/restart.ts";
import { LOCK, MSG, otherHolder } from "../src/commands/restart-lock.ts";
import type { DaemonRequest, DaemonResponse, PageState } from "../src/daemon/protocol.ts";
import { dispatch } from "../src/daemon/server.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createSerializer } from "../src/serialize.ts";
import { ensureSessionDir, loadState, profileDir, saveState, sessionDir } from "../src/state.ts";
import { waitFor } from "./helpers/daemons.ts";
import { daemonOf, fakeDaemon, lineSocket, SILENT, type Answer, type FakeDaemon } from "./helpers/fake-daemon.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let tmp: string;
let origHome: string | undefined;
/** A live process that `ps` shows as bowser: the `upg` lock trusts no other holder (ET-35). */
let holder: Bun.Subprocess;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-lifecycle-"));
  process.env.HOME = tmp;
  const cli = join(tmp, "holder", "src", "cli.ts");
  await Bun.write(cli, "await Bun.sleep(600_000);\n");
  holder = Bun.spawn([process.execPath, cli]);
  // Until its exec, ps shows the parent's command line, which is not bowser.
  if (!(await waitFor(() => isBowser(holder.pid)))) throw new Error("the lock holder never looked like bowser");
});

afterAll(async () => {
  holder.kill();
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

/** Another process's restart finishing: `work` runs after 300 ms. Await the
 *  result in `finally`, or a daemon it starts outlives the test. */
function meanwhile<T>(work: () => Promise<T>): Promise<T> {
  return Bun.sleep(300).then(work);
}

/** An older daemon on the session's socket that stops on `shutdown`, and the
 *  connector a restart reconnects through: once the old one is down, it puts
 *  a daemon of this version on the socket, answering `state` with `url` and
 *  `profile`, as a spawned one would. The old one shows `oldUrl`, else `url`,
 *  or answers `state` with `oldState`. */
async function upgrade(session: string, answer: string, page: { url?: string; oldUrl?: string; oldState?: unknown; profile?: string }) {
  const url = page.url ?? "about:blank";
  let next: FakeDaemon | undefined;
  const old: FakeDaemon = await fakeDaemon(session, (req) => {
    if (req.op === "shutdown") queueMicrotask(() => old.stop());
    if (req.op === "state" && page.oldState !== undefined) return page.oldState;
    return daemonOf(answer, page.oldUrl ?? url)(req);
  });
  const current: Answer = (req) => (req.op === "state" ? ({ url, title: "", profile: page.profile } satisfies PageState) : daemonOf(pkg.version)(req));
  const connect = async (s: string, o?: ConnectOptions) => {
    if (old.ops.includes("shutdown") && !next) next = await fakeDaemon(session, current);
    return connectOrSpawn(s, o);
  };
  return {
    old,
    next: () => next,
    connect,
    stop: () => {
      old.stop();
      next?.stop();
    },
  };
}

describe("F2: a daemon from another bowser version", () => {
  const cases = [
    { label: "an old daemon (no version)", answer: "pong", v: "an older version" },
    { label: "a daemon of another version", answer: "0.6.1", v: "0.6.1" },
  ];

  for (const { label, answer, v } of cases) {
    test(`${label}: restarts an older daemon and says what was lost`, async () => {
      const session = `ver-${answer.replaceAll(".", "")}`;
      await saveState({
        name: session,
        url: "https://example.com/cart",
        title: "Cart",
        refs: [],
        updatedAt: 0,
        profile: null,
      });
      const up = await upgrade(session, answer, { url: "https://example.com/cart" });
      try {
        const notices: string[] = [];
        expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
        expect(notices).toEqual([
          `session '${session}' restarted for bowser ${pkg.version} (was ${v}): page reloaded at https://example.com/cart; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`,
        ]);
        expect(up.old.ops.filter((op) => op !== "ping")).toEqual(["state", "shutdown"]);
        expect(up.next()?.ops).toContain("navigate");
        expect(existsSync(join(sessionDir(session), LOCK))).toBe(false);
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
      expect(notices).toEqual([`session '${session}' restarted for bowser ${pkg.version} (was 0.6.1): no page was open; refs cleared, run 'bowser snapshot'`]);
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

  test("a restart that finds a newer daemon once it holds the lock refuses it and stops nothing", async () => {
    const session = "ver-newer-after-lock";
    const d = await fakeDaemon(session, daemonOf("99.0.0"));
    try {
      const err = await restartSession({ session, json: false, notices: [] }, new OlderDaemon("old", "0.6.1")).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((err as Error).message).toBe(
        `session '${session}' is running bowser 99.0.0 (this is ${pkg.version}); run 'bowser close -s ${session}', then open it again`,
      );
      expect(d.ops).not.toContain("shutdown");
    } finally {
      d.stop();
    }
  });

  test("a command that finds no daemon while another restarts the session waits for it (#149)", async () => {
    const session = "ver-mid-restart";
    await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: null });
    const lock = join(sessionDir(session), LOCK);
    await Bun.write(lock, String(holder.pid));
    const next = meanwhile(async () => {
      const d = await fakeDaemon(session, daemonOf(pkg.version));
      await unlink(lock);
      return d;
    });
    try {
      expect(await run(["eval", "1", "-s", session])).toBe("1");
    } finally {
      (await next).stop();
    }
  });

  test("with BOWSER_OP_TIMEOUT_MS=0, a held restart lock is waited for without a deadline (#149)", async () => {
    const session = "ver-nobudget";
    await ensureSessionDir(session);
    const lock = join(sessionDir(session), LOCK);
    await Bun.write(lock, String(holder.pid));
    const old = await fakeDaemon(session, daemonOf("0.6.1"));
    const next = meanwhile(async () => {
      old.stop();
      await unlink(socketPath(session)).catch(() => {});
      const d = await fakeDaemon(session, daemonOf(pkg.version));
      await unlink(lock);
      return d;
    });
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "0";
    try {
      expect(await run(["eval", "1", "-s", session])).toBe("1");
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
      old.stop();
      (await next).stop();
    }
  });

  test("a restart whose reload fails clears the saved refs (#149)", async () => {
    const session = "ver-noreload";
    const ref = { id: "e1", role: "button", name: "Add", tag: "button" };
    await saveState({
      name: session,
      url: "https://example.com/cart",
      title: "Cart",
      refs: [ref],
      doc: "d1",
      updatedAt: 0,
      profile: null,
    });
    const up = await upgrade(session, "0.6.1", { oldUrl: "https://example.com/cart" });
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
      expect(notices[0]).toContain("page did not reload at https://example.com/cart");
      const state = await loadState(session);
      expect(state?.refs).toEqual([]);
      expect(state?.doc).toBeUndefined();
    } finally {
      up.stop();
    }
  });

  test("a restart whose stop fails keeps the saved refs (#149)", async () => {
    const session = "ver-nostop";
    const ref = { id: "e1", role: "button", name: "Add", tag: "button" };
    await saveState({
      name: session,
      url: "https://example.com/cart",
      title: "Cart",
      refs: [ref],
      doc: "d1",
      updatedAt: 0,
      profile: null,
    });
    // A live pid that is not a daemon of ours: the stop refuses to signal it.
    await Bun.write(join(sessionDir(session), "pid"), String(process.ppid));
    const up = await upgrade(session, "0.6.1", {});
    try {
      const err = await run(["eval", "1", "-s", session], { connect: up.connect, notices: [] }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((err as Error).message).toContain("does not look like a bowser daemon");
      expect((await loadState(session))?.refs).toEqual([ref]);
    } finally {
      await unlink(join(sessionDir(session), "pid")).catch(() => {});
      up.stop();
    }
  }, 10_000);

  test("with no package.json on disk, an older daemon is still refused", async () => {
    const session = "ver-noinstall";
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    const connect = (s: string, o?: ConnectOptions) => connectOrSpawn(s, { ...o, installedVersion: async () => undefined });
    try {
      const err = await run(["snapshot", "-s", session], { connect }).then(
        () => undefined,
        (e: unknown) => e,
      );
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
    await Bun.write(join(sessionDir(session), LOCK), String(dead.pid));
    const up = await upgrade(session, "0.6.1", {});
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices })).toBe("1");
      expect(notices).toHaveLength(1);
      expect(existsSync(join(sessionDir(session), LOCK))).toBe(false);
    } finally {
      up.stop();
    }
  });

  test("restart lock: a live holder is waited for, and the daemon it started is used", async () => {
    const session = "ver-livelock";
    await ensureSessionDir(session);
    const lock = join(sessionDir(session), LOCK);
    await Bun.write(lock, String(holder.pid));
    const old = await fakeDaemon(session, daemonOf("0.6.1"));
    const next = meanwhile(async () => {
      old.stop();
      await unlink(socketPath(session)).catch(() => {});
      const d = await fakeDaemon(session, daemonOf(pkg.version));
      await unlink(lock);
      return d;
    });
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { notices })).toBe("1");
      expect(notices).toEqual([]);
      expect(old.ops).not.toContain("shutdown");
    } finally {
      old.stop();
      (await next).stop();
    }
  });

  test("restart lock: a holder that outlasts the budget fails the command and leaves the daemon alone", async () => {
    const session = "ver-heldlock";
    await ensureSessionDir(session);
    const lock = join(sessionDir(session), LOCK);
    await Bun.write(lock, String(holder.pid));
    const d = await fakeDaemon(session, daemonOf("0.6.1"));
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "300";
    try {
      expect(await failure(["eval", "1", "-s", session])).toEqual({
        stderr: `bowser: session '${session}' is being restarted by pid ${holder.pid} (${lock}); retry in a moment`,
        code: 1,
      });
      expect(d.ops).not.toContain("shutdown");
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
      await unlink(lock);
      d.stop();
    }
  });

  describe("a process whose version differs from the installed bowser (#79)", () => {
    const refusal = (session: string, installedVersion: () => Promise<string | undefined>) =>
      connectOrSpawn(session, { installedVersion }).then(
        () => "no refusal",
        (e: unknown) => (e as Error).message,
      );

    for (const [label, installed] of [
      ["an upgrade", "99.0.0"],
      ["a downgrade", "0.0.1"],
    ] as const) {
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

  test("#235: a daemon of this version from an older build names the command and the fix", async () => {
    const session = "235-unknown-op-ver";
    const d = await fakeDaemon(session, (req) => (req.op === "waitFor" ? { ok: false, error: "unknown op: waitFor" } : daemonOf(pkg.version)(req)));
    try {
      const failure = await run(["wait-for", "--text=x", "-s", session]).then((out) => ({ stderr: `no failure: ${out}`, code: 0 }), reportFailure);
      expect(failure).toEqual({
        stderr: `bowser: session '235-unknown-op-ver' was started by an older bowser build that does not know 'wait-for'; run 'bowser close -s 235-unknown-op-ver', then open it again`,
        code: 1,
      });
    } finally {
      d.stop();
    }
  });

  test("#235: a state.json the hint cannot read still fails the command, with the plain hint", async () => {
    const session = "235-unknown-op-bad";
    const d = await fakeDaemon(session, (req) => (req.op === "waitFor" ? { ok: false, error: "unknown op: waitFor" } : daemonOf(pkg.version)(req)));
    try {
      await Bun.write(join(sessionDir(session), "state.json"), JSON.stringify({ name: session, profile: { dir: "a b" } }));
      const failure = await run(["wait-for", "--text=x", "-s", session]).then((out) => ({ stderr: `no failure: ${out}`, code: 0 }), reportFailure);
      expect(failure).toEqual({
        stderr: `bowser: session '235-unknown-op-bad' was started by an older bowser build that does not know 'wait-for'; run 'bowser close -s 235-unknown-op-bad', then open it again`,
        code: 1,
      });
    } finally {
      d.stop();
    }
  }, 2000);
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
    const bound = Bun.spawnSync([
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath(session))}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect(bound.exitCode).not.toBe(0);
    expect(existsSync(socketPath(session))).toBe(true);
    expect(await run(["close", "-s", session])).toBe(`closed session '${session}'`);
    expect(existsSync(sessionDir(session))).toBe(false);
  });
});

describe("F32: list", () => {
  /** `bowser list` as its own process under `home`: its stdout, its wall
   *  time, and how long it lived after its last output. */
  async function timedList(home = tmp): Promise<{ out: string; ms: number; afterOutput: number }> {
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, CLI, "list"], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    let printed = started;
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      out += decoder.decode(chunk);
      printed = performance.now();
    }
    await proc.exited;
    const exited = performance.now();
    return { out, ms: exited - started, afterOutput: exited - printed };
  }

  test("with a live session, exits as soon as it has printed", async () => {
    const d = await fakeDaemon("live32", daemonOf(pkg.version));
    try {
      const { out, afterOutput } = await timedList();
      expect(out.split("\n")).toContain("live32");
      // Right: about 0 ms; wrong: a 1000 ms timer left pending after the print.
      expect(afterOutput).toBeLessThan(500);
    } finally {
      d.stop();
      await rm(sessionDir("live32"), { recursive: true, force: true });
    }
  }, 10_000);

  test("a daemon that never answers is not listed, within the probe bound", async () => {
    const d = await fakeDaemon("mute32", () => SILENT);
    try {
      // Concurrent, so both pay the same startup under load.
      const [mute, empty] = await Promise.all([timedList(), timedList(await mkdtemp(join(tmp, "empty32-")))]);
      expect(mute.out.split("\n")).not.toContain("mute32");
      // Right: one HEALTH_PING_MS (1000) over an empty list; wrong: a second probe, 2000.
      expect(mute.ms - empty.ms).toBeLessThan(1500);
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
          handle,
          serialize,
          timeoutMs: 50,
          reply: (res) => {
            s.write(JSON.stringify(res) + "\n");
          },
        });
      }),
    });
  }

  async function seed(session: string) {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      updatedAt: 1,
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

describe("ET-59: a daemon that stops answering mid-op", () => {
  async function withBudget<T>(ms: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = ms;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
    }
  }

  const notAnswering = (s: string) => `daemon for session '${s}' did not answer; run 'bowser close -s ${s}' to stop it`;

  test("ET-59: a command fails at budget plus margin when its daemon stops answering mid-op", async () => {
    const session = "et59stuck";
    const d = await fakeDaemon(session, (req) => (req.op === "evaluate" ? SILENT : daemonOf(pkg.version)(req)));
    try {
      const t0 = Date.now();
      const result = await withBudget("300", () => failure(["eval", "1", "-s", session]));
      const elapsed = Date.now() - t0;
      expect(result).toEqual({ stderr: `bowser: ${notAnswering(session)}`, code: 2 });
      expect(elapsed).toBeGreaterThanOrEqual(2300);
      // 300 + CLIENT_MARGIN_MS = 2300; the margin added twice would be 4300.
      expect(elapsed).toBeLessThan(3300);
    } finally {
      d.stop();
    }
  }, 10_000);

  test("ET-59: the daemon's own late timeout reply wins over the client deadline", async () => {
    const session = "et59late";
    const d = await fakeDaemon(session, (req) =>
      req.op === "evaluate" ? Bun.sleep(1300).then(() => ({ ok: false, error: "'eval' timed out after 300ms" })) : daemonOf(pkg.version)(req),
    );
    try {
      expect(await withBudget("300", () => failure(["eval", "1", "-s", session]))).toEqual({
        stderr: "bowser: 'eval' timed out after 300ms",
        code: 2,
      });
    } finally {
      d.stop();
    }
  });

  test("ET-59: budget 0 sets no client deadline", async () => {
    const session = "et59zero";
    const d = await fakeDaemon(session, (req) => (req.op === "evaluate" ? Bun.sleep(2500).then(() => 1) : daemonOf(pkg.version)(req)));
    try {
      expect(await withBudget("0", () => run(["eval", "1", "-s", session]))).toBe("1");
    } finally {
      d.stop();
    }
  });

  test("ET-59: over MCP, the next call on the session answers after the frozen one fails", async () => {
    const session = "et59mcp";
    let frozen = false;
    const d = await fakeDaemon(session, (req) => {
      if (req.op === "evaluate") frozen = true;
      return frozen ? SILENT : daemonOf(pkg.version)(req);
    });
    const answered: Array<{
      at: number;
      res: { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };
    }> = [];
    const server = createMcpServer({ version: pkg.version, run }, (line) => {
      answered.push({ at: Date.now(), res: JSON.parse(line) });
    });
    const call = (id: number) =>
      server.accept(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "eval", arguments: { expression: "1", session } },
        }),
      );
    try {
      const t0 = Date.now();
      await withBudget("300", async () => {
        call(1);
        call(2);
        await server.idle();
      });
      expect(answered.map((a) => a.res.id)).toEqual([1, 2]);
      for (const { res } of answered) {
        expect(res.result.isError).toBe(true);
        expect(res.result.content[0]!.text).toBe(notAnswering(session));
      }
      expect(answered[0]!.at - t0).toBeLessThan(3300);
      expect(answered[1]!.at - answered[0]!.at).toBeLessThan(1650);
    } finally {
      d.stop();
    }
  }, 10_000);
});

describe("#152: close against an upgrade restart, and the restart's notice", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmp, "et-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = home;
  });
  afterAll(() => {
    process.env.HOME = tmp;
  });

  const lockOf = (s: string) => join(sessionDir(s), LOCK);
  const msgOf = (s: string) => join(sessionDir(s), MSG);
  const left = (s: string) => ["state.json", "pid", "sock"].filter((f) => existsSync(join(sessionDir(s), f)));
  const notice = (s: string, reload: string) =>
    `session '${s}' restarted for bowser ${pkg.version} (was 0.6.1): ${reload}; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`;
  const closedWhileWaiting = (s: string) => `bowser: session '${s}' was closed while this command waited to restart it`;
  async function deadPid(): Promise<number> {
    const p = Bun.spawn(["true"]);
    await p.exited;
    return p.pid;
  }
  /** A connector that records the options of every connect. */
  function recording() {
    const calls: ConnectOptions[] = [];
    return {
      calls,
      connect: (s: string, o: ConnectOptions = {}) => {
        calls.push(o);
        return connectOrSpawn(s, o);
      },
    };
  }
  async function failing(argv: string[], base: Parameters<typeof run>[1]) {
    return run(argv, base).then((out) => ({ stderr: `no failure: ${out}`, code: 0 }), reportFailure);
  }

  for (const all of [false, true]) {
    test(`${all ? "close --all" : "close"} waits for a restart in progress, then ends the daemon it started (ET-32)`, async () => {
      const session = all ? "et32-wait-all" : "et32-wait";
      // close --all sees every session in HOME, and the other tests leave theirs.
      process.env.HOME = await mkdtemp(join(tmp, "et32-"));
      await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: null });
      await Bun.write(lockOf(session), String(holder.pid));
      const old = await fakeDaemon(session, daemonOf("0.6.1"));
      const next = meanwhile(async () => {
        old.stop();
        await unlink(socketPath(session)).catch(() => {});
        const d = await fakeDaemon(session, daemonOf(pkg.version));
        await unlink(lockOf(session));
        return d;
      });
      try {
        const out = await run(all ? ["close", "--all"] : ["close", "-s", session]);
        expect(out).toBe(all ? `closed 1 session: ${session}` : `closed session '${session}'`);
        expect((await next).ops).toContain("shutdown");
        expect(old.ops).not.toContain("shutdown");
        expect(left(session)).toEqual([]);
      } finally {
        old.stop();
        (await next).stop();
      }
    });
  }

  const waitedForClose: { label: string; noDaemon?: true; close: (s: string) => Promise<void> }[] = [
    { label: "the directory is gone at the claim", close: (s) => rm(sessionDir(s), { recursive: true, force: true }) },
    {
      label: "the claim lands in the empty directory before close's rmdir",
      close: async (s) => {
        const dir = sessionDir(s);
        for (const e of await readdir(dir)) if (e !== LOCK) await rm(join(dir, e), { recursive: true, force: true });
        await unlink(join(dir, LOCK));
      },
    },
    {
      label: "no daemon (BrowserExited)",
      noDaemon: true,
      close: (s) => rm(sessionDir(s), { recursive: true, force: true }),
    },
  ];
  for (const [i, c] of waitedForClose.entries()) {
    test(`a restart that waited for close fails and starts nothing (ET-32): ${c.label}`, async () => {
      const session = `et32-closed-${i}`;
      await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: null });
      await Bun.write(lockOf(session), String(holder.pid));
      const old = c.noDaemon ? undefined : await fakeDaemon(session, daemonOf("0.6.1"));
      const closed = meanwhile(async () => {
        old?.stop();
        await c.close(session);
      });
      const r = recording();
      try {
        expect(await failing(["eval", "1", "-s", session], { connect: r.connect })).toEqual({
          stderr: closedWhileWaiting(session),
          code: 1,
        });
        expect(r.calls.slice(1).every((o) => o.spawn === false)).toBe(true);
        expect(left(session)).toEqual([]);
        expect(await run(["list"])).not.toContain(session);
      } finally {
        old?.stop();
        await closed;
      }
    });
  }

  for (const keepState of [false, true]) {
    test(`a command whose restart finished before close ran does not spawn (ET-32)${keepState ? ": state.json left" : ""}`, async () => {
      const session = keepState ? "et32-gap-state" : "et32-gap";
      await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: null });
      const calls: ConnectOptions[] = [];
      const connect = async (s: string, o: ConnectOptions = {}) => {
        calls.push(o);
        if (calls.length === 1) throw new OlderDaemon("old", "0.6.1");
        if (o.spawn === false) throw new NoDaemon(s);
        throw new Error("spawn allowed");
      };
      const restart = async () => {
        if (!keepState) await rm(sessionDir(session), { recursive: true, force: true });
        return true;
      };
      const { stderr, code } = await failing(["eval", "1", "-s", session], { connect, restart, notices: [] });
      expect(code).toBe(1);
      if (keepState) expect(stderr).toContain(`bowser: session '${session}' is not open (its browser exited)`);
      else expect(stderr).toBe(closedWhileWaiting(session));
      expect(calls.slice(1).map((o) => o.spawn)).toEqual([false]);
    });
  }

  test("a second close that finds the directory gone during its claim answers without an error (ET-32)", async () => {
    const session = "et32-second";
    await ensureSessionDir(session);
    let claimed = false;
    const claim: typeof claimSession = async (...args) => {
      claimed = true;
      await rm(sessionDir(session), { recursive: true, force: true });
      return claimSession(...args);
    };
    expect(await closeOne({ session, json: false }, session, undefined, claim)).toBe(`session '${session}' is not open`);
    expect(claimed).toBe(true);
  });

  test("a claim that macOS fails with EINVAL as close removes the directory reads as closed (#232)", async () => {
    const session = "et32-einval";
    await ensureSessionDir(session);
    const claim: typeof claimSession = async () => {
      await rm(sessionDir(session), { recursive: true, force: true });
      throw Object.assign(new Error("EINVAL: invalid argument, link"), { code: "EINVAL" });
    };
    expect(await closeOne({ session, json: false }, session, undefined, claim)).toBe(`session '${session}' is not open`);
  });

  test("a restart that never finishes leaves its notice for the next command (ET-29)", async () => {
    const session = "et29-hung";
    const url = "https://example.com/cart";
    await saveState({ name: session, url, title: "", refs: [], updatedAt: 0, profile: null });
    const old: FakeDaemon = await fakeDaemon(session, (req) => {
      if (req.op === "shutdown") queueMicrotask(() => old.stop());
      return daemonOf("0.6.1", url)(req);
    });
    let hung = false;
    const hang = (s: string, o?: ConnectOptions) => {
      if (!old.ops.includes("shutdown") || o?.spawn === false) return connectOrSpawn(s, o);
      hung = true;
      return new Promise<never>(() => {});
    };
    void run(["eval", "1", "-s", session], { connect: hang, notices: [] });
    expect(await waitFor(() => hung, 3000)).toBe(true);
    await Bun.write(lockOf(session), String(await deadPid()));
    const current = await fakeDaemon(session, daemonOf(pkg.version));
    try {
      const notices: string[] = [];
      const acks: (() => void)[] = [];
      expect(await run(["eval", "1", "-s", session], { notices, acks })).toBe("1");
      expect(notices).toEqual([notice(session, `page reload at ${url} was interrupted`)]);
      for (const ack of acks) ack();
      const after: string[] = [];
      expect(await run(["eval", "1", "-s", session], { notices: after })).toBe("1");
      expect(after).toEqual([]);
    } finally {
      current.stop();
    }
  });

  test("a command that finds no daemon after a killed restart prints the notice with its error (ET-29)", async () => {
    const session = "et29-nodaemon";
    const text = notice(session, "page reload at https://example.com/ was interrupted");
    await saveState({ name: session, url: "https://example.com/", title: "", refs: [], updatedAt: 0, profile: null });
    await Bun.write(msgOf(session), text);
    await Bun.write(lockOf(session), String(await deadPid()));
    const notices: string[] = [];
    const { stderr, code } = await failing(["localstorage-get", "tok", "-s", session], { notices, acks: [] });
    expect(stderr).toContain(`session '${session}' is not open (its browser exited)`);
    expect(code).toBe(1);
    expect(notices).toEqual([text]);
  });

  test("a restart prints its notice once and never waits on its own lock (ET-29)", async () => {
    const session = "et29-own";
    const url = "https://example.com/cart";
    await saveState({ name: session, url, title: "", refs: [], updatedAt: 0, profile: null });
    const up = await upgrade(session, "0.6.1", { url });
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = "0";
    try {
      const notices: string[] = [];
      const started = performance.now();
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices, acks: [] })).toBe("1");
      expect(performance.now() - started).toBeLessThan(2000);
      expect(notices).toEqual([notice(session, `page reloaded at ${url}`)]);
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
      up.stop();
    }
  });

  test("a restart prints its notice while another command holds the lock to check the daemon (#171)", async () => {
    const session = "et29-checker";
    const text = notice(session, "no page was open");
    await ensureSessionDir(session);
    const d = await fakeDaemon(session, daemonOf(pkg.version));
    let calls = 0;
    const connect = (s: string, o?: ConnectOptions) => {
      if (++calls === 1) throw new OlderDaemon("old", "0.6.1");
      return connectOrSpawn(s, o);
    };
    // The restart is done and its lock released; the second command claimed it.
    const restart = async () => {
      await Bun.write(msgOf(session), text);
      await Bun.write(lockOf(session), String(holder.pid));
      return true;
    };
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect, restart, notices, acks: [] })).toBe("1");
      expect(notices).toEqual([text]);
    } finally {
      d.stop();
    }
  });

  test("the CLI marks a notice delivered only once it has printed it (ET-29)", async () => {
    const session = "et29-cli";
    const text = notice(session, "no page was open");
    await ensureSessionDir(session);
    await Bun.write(msgOf(session), text);
    const d = await fakeDaemon(session, daemonOf(pkg.version));
    const cli = async () => {
      const proc = Bun.spawn([process.execPath, CLI, "eval", "1", "-s", session], {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { out, err };
    };
    try {
      expect(await cli()).toEqual({ out: "1\n", err: `bowser: ${text}\n` });
      expect(existsSync(msgOf(session))).toBe(false);
      expect(await cli()).toEqual({ out: "1\n", err: "" });
    } finally {
      d.stop();
    }
  });

  test("a command that waited for another's restart leaves the notice to it (ET-29)", async () => {
    const session = "et29-waiter";
    const text = notice(session, "no page was open");
    await ensureSessionDir(session);
    await Bun.write(msgOf(session), text);
    await Bun.write(lockOf(session), String(holder.pid));
    const old = await fakeDaemon(session, daemonOf("0.6.1"));
    const next = meanwhile(async () => {
      old.stop();
      await unlink(socketPath(session)).catch(() => {});
      const d = await fakeDaemon(session, daemonOf(pkg.version));
      await unlink(lockOf(session));
      return d;
    });
    try {
      const notices: string[] = [];
      expect(await run(["eval", "1", "-s", session], { notices, acks: [] })).toBe("1");
      expect(notices).toEqual([]);
      expect(await Bun.file(msgOf(session)).text()).toBe(text);
    } finally {
      old.stop();
      (await next).stop();
    }
  });

  test("a command that takes over a dead holder's restart prints only its own notice (ET-29)", async () => {
    const session = "et29-takeover";
    const url = "https://example.com/cart";
    await saveState({ name: session, url, title: "", refs: [], updatedAt: 0, profile: null });
    await Bun.write(msgOf(session), notice(session, `page reload at ${url} was interrupted`));
    await Bun.write(lockOf(session), String(await deadPid()));
    const up = await upgrade(session, "0.6.1", { url });
    try {
      const notices: string[] = [];
      const acks: (() => void)[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices, acks })).toBe("1");
      expect(notices).toEqual([notice(session, `page reloaded at ${url}`)]);
      for (const ack of acks) ack();
      const after: string[] = [];
      expect(await run(["eval", "1", "-s", session], { connect: up.connect, notices: after })).toBe("1");
      expect(after).toEqual([]);
    } finally {
      up.stop();
    }
  });
});

test("close removes a session whose restart lock is corrupt (#152)", async () => {
  const session = "corrupt-upg";
  await saveState({ name: session, url: "", title: "", refs: [], updatedAt: 0, profile: null });
  await Bun.write(join(sessionDir(session), LOCK), "nope");
  const prev = process.env.BOWSER_OP_TIMEOUT_MS;
  process.env.BOWSER_OP_TIMEOUT_MS = "300";
  try {
    expect(await run(["close", "-s", session])).toBe(`closed session '${session}'`);
    expect(existsSync(sessionDir(session))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = prev;
  }
});

describe("#152: the restart keeps the session's page and budget", () => {
  const start = "https://example.com/start";
  const moved = "https://example.com/moved";
  const reloaded = (s: string, url: string) =>
    `session '${s}' restarted for bowser ${pkg.version} (was 0.6.1): page reloaded at ${url}; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`;
  async function withBudget<T>(ms: string, work: () => Promise<T>): Promise<T> {
    const prev = process.env.BOWSER_OP_TIMEOUT_MS;
    process.env.BOWSER_OP_TIMEOUT_MS = ms;
    try {
      return await work();
    } finally {
      if (prev === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
      else process.env.BOWSER_OP_TIMEOUT_MS = prev;
    }
  }
  /** Restarts `session` (state.json on `start`) through `upgrade`, recording every connect's options. */
  async function restart(session: string, page: Parameters<typeof upgrade>[2]) {
    await saveState({ name: session, url: start, title: "", refs: [], updatedAt: 0, profile: null });
    const up = await upgrade(session, "0.6.1", page);
    const calls: ConnectOptions[] = [];
    const notices: string[] = [];
    try {
      const out = await run(["eval", "1", "-s", session], {
        connect: (s, o = {}) => {
          calls.push(o);
          return up.connect(s, o);
        },
        notices,
      });
      return { out, notices, calls, old: up.old.ops };
    } finally {
      up.stop();
    }
  }
  const budgets = (calls: ConnectOptions[]) => calls.filter((o) => "daemonBudgetMs" in o).map((o) => o.daemonBudgetMs);

  test("ET-33: reopens the page the old daemon shows, not the one in state.json", async () => {
    const r = await restart("et33-moved", { url: moved, oldUrl: moved });
    expect(r.out).toBe("1");
    expect(r.notices).toEqual([reloaded("et33-moved", moved)]);
  });

  test("ET-33: falls back to state.json when the old daemon cannot answer state", async () => {
    const r = await restart("et33-fallback", { url: start, oldState: { ok: false, error: "unknown op: state" } });
    expect(r.notices).toEqual([reloaded("et33-fallback", start)]);
  });

  test("ET-33, a busy old daemon: the state request gives up after the health ping, at budget 0 too", async () => {
    const started = performance.now();
    const r = await withBudget("0", () => restart("et33-busy", { url: start, oldState: SILENT }));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(r.old).toContain("shutdown");
    expect(r.notices).toEqual([reloaded("et33-busy", start)]);
  });

  test("ET-30: the new daemon gets the old one's budget, not the restarting command's", async () => {
    const r = await withBudget("200", () => restart("et30-kept", { url: start, oldState: { url: start, title: "", budgetMs: 45000 } }));
    expect(budgets(r.calls)).toEqual([45000]);
  });

  test("ET-30: an old daemon that reports no budget gets the default (from 0.12)", async () => {
    const r = await withBudget("200", () => restart("et30-default", { url: start }));
    expect(budgets(r.calls)).toEqual([null]);
  });

  test("ET-30, no cap: a budget of 0 stays 0", async () => {
    const r = await withBudget("200", () => restart("et30-zero", { url: start, oldState: { url: start, title: "", budgetMs: 0 } }));
    expect(budgets(r.calls)).toEqual([0]);
  });

  test("ET-35: a lock held by a live bowser process still counts", async () => {
    const session = "et35-bowser";
    await ensureSessionDir(session);
    await Bun.write(join(sessionDir(session), LOCK), String(holder.pid));
    try {
      expect(otherHolder(session)).toBe(holder.pid);
    } finally {
      // close --all in other tests would wait out its budget on a live holder.
      await rm(sessionDir(session), { recursive: true, force: true });
    }
  });

  test("ET-35: a lock held by a live process that is not bowser counts as stale", async () => {
    const session = "et35-stranger";
    const stranger = Bun.spawn(["sleep", "30"]);
    try {
      await ensureSessionDir(session);
      await Bun.write(join(sessionDir(session), LOCK), String(stranger.pid));
      expect(otherHolder(session)).toBeNull();
      const started = performance.now();
      const r = await withBudget("3000", () => restart(session, { url: start }));
      expect(performance.now() - started).toBeLessThan(2000);
      expect(r.notices).toEqual([reloaded(session, start)]);
    } finally {
      stranger.kill();
    }
  });
});
