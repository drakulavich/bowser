// The daemon client: socket and pid paths, spawning, the health check, and a
// daemon that goes away mid-request.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureSessionDir, saveState } from "../src/state.ts";

import pkg from "../package.json";
import { reportFailure } from "../src/cli.ts";
import { connectOrSpawn, DaemonNotAnswering, pidPath, socketPath } from "../src/daemon/client.ts";
import { removePidFileIfOwned } from "../src/daemon/server.ts";
import { claimSession } from "../src/daemon/pidfile.ts";
import { daemonPids, killDaemons, waitFor } from "./helpers/daemons.ts";

describe("socketPath", () => {
  test("resolves under process.env.HOME at call time", () => {
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/bowser-sockpath-test";
    try {
      expect(socketPath("sess")).toBe("/tmp/bowser-sockpath-test/.bowser/sessions/sess/sock");
    } finally {
      if (orig !== undefined) process.env.HOME = orig; else delete process.env.HOME;
    }
  });
});

describe("pidPath", () => {
  test("sits beside the socket, resolved at call time", () => {
    const orig = process.env.HOME;
    process.env.HOME = "/tmp/bowser-pidpath-test";
    try {
      expect(pidPath("sess")).toBe("/tmp/bowser-pidpath-test/.bowser/sessions/sess/pid");
    } finally {
      if (orig !== undefined) process.env.HOME = orig; else delete process.env.HOME;
    }
  });
});

describe("pidfile cleanup", () => {
  test("does not remove a replacement daemon's pidfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bowser-pidfile-"));
    const path = join(dir, "pid");
    try {
      await Bun.write(path, "9999");
      removePidFileIfOwned(path, 4242);
      expect(await Bun.file(path).text()).toBe("9999");
      removePidFileIfOwned(path, 9999);
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("spawned daemon HOME propagation", () => {
  // Regression guard for the e2e "did not start in time" failure: the daemon is
  // spawned via Bun.spawn, and the e2e suite redirects process.env.HOME *after*
  // process startup. Without an explicit `env`, Bun.spawn inherits the OS environ
  // captured at startup and ignores that runtime mutation — so the daemon resolved
  // socketPath() against the real HOME while the client used the redirected one,
  // and they never met. spawnDaemon must pass `env: { ...process.env }` so a child
  // sees the live HOME. This asserts that exact propagation without a browser.
  test("a child spawned like the daemon sees a runtime HOME mutation", async () => {
    const orig = process.env.HOME;
    const redirected = `/tmp/bowser-home-prop-${Date.now()}`;
    process.env.HOME = redirected;
    try {
      // Mirror spawnDaemon's Bun.spawn options (the load-bearing part: env).
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", "process.stdout.write(process.env.HOME ?? '')"],
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        env: { ...process.env },
      });
      const seen = await new Response(child.stdout).text();
      await child.exited;
      expect(seen).toBe(redirected);
    } finally {
      if (orig !== undefined) process.env.HOME = orig; else delete process.env.HOME;
    }
  });
});

// bowser runs only WebKit's Bun.WebView, which exists only on macOS. The
// daemon would die opening it, seen by the CLI only as "did not start in
// time", so the CLI refuses before it spawns one.
describe("connectOrSpawn on a platform without WebKit", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-platform-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  for (const platform of ["linux", "win32"]) {
    test(`${platform}: refuses to spawn a daemon, a user error (exit 1)`, async () => {
      const session = `platform-${platform}`;
      const started = Date.now();
      const err = await connectOrSpawn(session, { platform }).then(() => undefined, (e: unknown) => e);
      expect((err as Error).message).toBe("bowser requires macOS (WebKit)");
      expect(reportFailure(err).code).toBe(1);
      // Refused before any spawn: no pidfile, and no wait for a startup timeout.
      expect(await Bun.file(pidPath(session)).exists()).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  }
});

// F7: npm does not enforce `engines.bun`, so an npm install runs on whatever
// Bun is on PATH. A daemon on a Bun without a working Bun.WebView would die
// unseen, and the CLI would print only "did not start in time". The floor is
// read from package.json, so the message follows it.
describe("connectOrSpawn on a Bun below the engines.bun floor", () => {
  let tmp: string;
  let origHome: string | undefined;
  const floor = (pkg as { engines: { bun: string } }).engines.bun;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-bunfloor-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const cases: [string, string, { version: string; webView: boolean }][] = [
    ["an older Bun", "bunfloor-old", { version: "1.0.0", webView: true }],
    ["a Bun without Bun.WebView", "bunfloor-noview", { version: "99.0.0", webView: false }],
  ];
  afterAll(async () => {
    // Only a regression spawns here; never leave its browser running.
    for (const [, session] of cases) await killDaemons(session);
  });
  for (const [label, session, runtime] of cases) {
    test(`${label}: refuses to spawn a daemon, a user error (exit 1)`, async () => {
      const started = Date.now();
      const err = await connectOrSpawn(session, { platform: "darwin", runtime }).then(() => undefined, (e: unknown) => e);
      expect((err as Error).message).toBe(`bowser requires Bun ${floor} (found ${runtime.version})`);
      expect(reportFailure(err).code).toBe(1);
      expect(await Bun.file(pidPath(session)).exists()).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  }
});

// F28: a session whose browser exited refuses every command but `open` and
// `close`, instead of quietly starting a new, empty browser. A session that
// never ran a daemon still starts one on its first command.
describe("connectOrSpawn after the session's browser exited (F28)", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-crashed-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const crashed = async (session: string): Promise<void> => {
    // What a dead daemon leaves: state.json, a pidfile naming no process, a socket file.
    await saveState({ name: session, url: "http://x/", title: "", refs: [], updatedAt: Date.now() });
    await Bun.write(pidPath(session), "99999");
    await Bun.write(socketPath(session), "");
  };

  test("refuses, as a user error, and starts nothing", async () => {
    const session = "crashed";
    await crashed(session);
    const started = Date.now();
    // platform: a spawn attempt would fail with its own message, not this one.
    const err = await connectOrSpawn(session, { platform: "linux" }).then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toBe("session 'crashed' is not open (its browser exited); run 'bowser open'");
    expect(reportFailure(err).code).toBe(1);
    expect((await Bun.file(pidPath(session)).text()).trim()).toBe("99999");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("open (reopen) still starts a daemon there", async () => {
    const session = "crashed-open";
    await crashed(session);
    // Past the refusal, the spawn path's own platform check answers.
    await expect(connectOrSpawn(session, { platform: "linux", reopen: true })).rejects.toThrow("bowser requires macOS (WebKit)");
  });

  test("a session that never ran a daemon still starts one", async () => {
    const session = "never-ran";
    await ensureSessionDir(session);
    await expect(connectOrSpawn(session, { platform: "linux" })).rejects.toThrow("bowser requires macOS (WebKit)");
  });
});

// A daemon can hold a connectable socket and never answer — stopped, or blocked
// in a syscall. Every command goes through this health check, so an unbounded
// wait there hangs the whole CLI, `list` included.
describe("connectOrSpawn health check", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-wedged-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("a socket that accepts and never answers counts as unreachable", async () => {
    const session = "wedged";
    await ensureSessionDir(session);
    const server = Bun.listen({ unix: socketPath(session), socket: { data() {} } });
    try {
      const started = Date.now();
      // Told apart from a refused connection even when no spawn is wanted:
      // `close` must not treat a running daemon's socket as stale (F3).
      await expect(connectOrSpawn(session, { spawn: false })).rejects.toBeInstanceOf(DaemonNotAnswering);
      await expect(connectOrSpawn(session)).rejects.toThrow(/run 'bowser close -s wedged'/);
      // The point is that it returns at all; the bound is generous so a loaded
      // CI machine does not fail on timing.
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  }, 15_000);
});

// A daemon that exits, crashes or is killed mid-request must not leave the
// request hanging: the CLI would stall with nothing to report.
describe("daemon goes away mid-request", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-gone-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** A fake daemon that answers `ping` and hangs up on any other op. */
  async function listenHangingUpDaemon(session: string) {
    await ensureSessionDir(session);
    return Bun.listen({
      unix: socketPath(session),
      socket: {
        data(s, data) {
          for (const line of data.toString().split("\n")) {
            if (!line) continue;
            const req = JSON.parse(line) as { id: number; op: string };
            if (req.op === "ping") s.write(JSON.stringify({ id: req.id, ok: true, result: pkg.version }) + "\n");
            else s.end();
          }
        },
      },
    });
  }

  /** How `p` settles within `ms`, as a string, so a hang fails the assertion
   *  instead of stalling the run. */
  async function outcomeWithin(p: Promise<unknown>, ms: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<string>((r) => {
      timer = setTimeout(() => r(`still pending after ${ms} ms`), ms);
    });
    try {
      return await Promise.race([
        p.then(
          (v) => `resolved: ${JSON.stringify(v)}`,
          (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
        ),
        pending,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  test("a request in flight fails when its daemon closes the connection", async () => {
    const session = "gone-in-flight";
    const server = await listenHangingUpDaemon(session);
    try {
      const client = await connectOrSpawn(session, { spawn: false });
      try {
        expect(await outcomeWithin(client.request("state"), 1000)).toBe(
          `rejected: daemon for session '${session}' closed the connection`,
        );
      } finally {
        client.close();
      }
    } finally {
      server.stop(true);
    }
  });

  test("a request after the daemon has gone fails at once", async () => {
    const session = "gone-after";
    const server = await listenHangingUpDaemon(session);
    try {
      const client = await connectOrSpawn(session, { spawn: false });
      try {
        const expected = `rejected: daemon for session '${session}' closed the connection`;
        expect(await outcomeWithin(client.request("state"), 1000)).toBe(expected);
        // Setup, not the pass condition: one hangup delivers `end` and then
        // `close` to the client, and a request issued between the two would be
        // failed by the late `close` rather than by the client knowing it is
        // closed. Bun delivers both within the same I/O turn, so letting the
        // event loop run past them puts this request after the socket is gone.
        await Bun.sleep(50);
        expect(await outcomeWithin(client.request("state"), 1000)).toBe(expected);
      } finally {
        client.close();
      }
    } finally {
      server.stop(true);
    }
  });
});

// F29: the claim a starting daemon makes on its session's pidfile, driven
// through claimSession by helper processes, with no browser. Each helper
// shows in `ps` as one of our daemons, so a winner that stays alive holds
// the session for the others.
describe("session claim (F29)", () => {
  const HELPER = join(import.meta.dir, "helpers", "claim-session.ts");
  let dir: string;
  const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bowser-claim-"));
  });

  afterAll(async () => {
    for (const p of spawned) p.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  const fresh = (content?: string): { pidFile: string; session: string } => {
    const session = `claim${n++}-${process.pid}`;
    const pidFile = join(dir, `${session}.pid`);
    if (content !== undefined) writeFileSync(pidFile, content);
    return { pidFile, session };
  };

  /** A newcomer, paused at `pauseAt` until released. */
  const newcomer = (pidFile: string, session: string, pauseAt = "-") => {
    const p = Bun.spawn([process.execPath, HELPER, pidFile, pauseAt, "/x/src/daemon/main.ts", session], {
      stdin: "ignore", stdout: "pipe", stderr: "inherit",
    });
    spawned.push(p);
    const said = (async () => {
      const { value } = await p.stdout.getReader().read();
      return new TextDecoder().decode(value).trim();
    })();
    return {
      proc: p,
      said,
      paused: () => waitFor(() => existsSync(`${pidFile}.paused-${p.pid}`), 5000),
      release: () => writeFileSync(`${pidFile}.release-${p.pid}`, ""),
    };
  };

  /** A process `ps` shows as our daemon for `session`: a live holder. */
  const liveHolder = async (session: string) => {
    const p = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1e9)", "/x/src/daemon/main.ts", session], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    spawned.push(p);
    await waitFor(async () => (await daemonPids(session)).includes(p.pid));
    return p;
  };

  test("a pidfile that is empty is never removed: no claim is ever written empty", async () => {
    const { pidFile, session } = fresh("");
    expect(await claimSession(pidFile, session)).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
    expect(await Bun.file(pidFile).text()).toBe("");
  });

  test("a pidfile naming a live daemon of ours is never removed", async () => {
    const { pidFile, session } = fresh();
    const holder = await liveHolder(session);
    writeFileSync(pidFile, String(holder.pid));
    expect(await claimSession(pidFile, session)).toBe(false);
    expect(await Bun.file(pidFile).text()).toBe(String(holder.pid));
  });

  test("a stale pidfile (dead pid) is removed and claimed", async () => {
    const { pidFile, session } = fresh("99999");
    const a = newcomer(pidFile, session);
    expect(await a.said).toBe("won");
    expect(await Bun.file(pidFile).text()).toBe(String(a.proc.pid));
  });

  // Two newcomers read the same stale pid; A removes it and claims before B
  // removes. B must re-read under the lock and leave A's claim alone.
  test("a newcomer that read a stale pid leaves the claim made since then alone", async () => {
    const { pidFile, session } = fresh("99999");
    const b = newcomer(pidFile, session, "stale-read");
    expect(await b.paused()).toBe(true);
    const a = newcomer(pidFile, session);
    expect(await a.said).toBe("won");
    b.release();
    expect(await b.said).toBe("lost");
    expect(await Bun.file(pidFile).text()).toBe(String(a.proc.pid));
  });

  // B holds the removal lock, has re-read the stale pid and is about to
  // remove it. A, reading the same stale pid, must not remove and claim in
  // the meantime: B's removal would then take A's claim.
  test("a newcomer does not remove a stale pidfile while another is removing it", async () => {
    const { pidFile, session } = fresh("99999");
    const b = newcomer(pidFile, session, "rechecked");
    expect(await b.paused()).toBe(true);
    const a = newcomer(pidFile, session);
    expect(await a.said).toBe("lost");
    b.release();
    expect(await b.said).toBe("won");
    expect(await Bun.file(pidFile).text()).toBe(String(b.proc.pid));
  });
});
