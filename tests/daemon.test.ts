// Tests that the parent process validates backend config before spawning the
// (silent, detached) daemon — so a bad BOWSER_BACKEND fails fast with a clear,
// actionable message instead of being swallowed and surfacing as a 5s startup
// timeout. See docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureSessionDir } from "../src/state.ts";

import { connectOrSpawn, pidPath, socketPath } from "../src/daemon/client.ts";
import { removePidFileIfOwned } from "../src/daemon/server.ts";

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
  // sees the live HOME. This asserts that exact propagation without needing Chromium.
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

describe("connectOrSpawn backend validation", () => {
  let origBackend: string | undefined;

  beforeEach(() => {
    origBackend = process.env.BOWSER_BACKEND;
  });

  afterEach(() => {
    if (origBackend !== undefined) process.env.BOWSER_BACKEND = origBackend;
    else delete process.env.BOWSER_BACKEND;
  });

  test("invalid BOWSER_BACKEND rejects before spawning the daemon", async () => {
    process.env.BOWSER_BACKEND = "firefox";
    // A unique session with no running daemon: connect fails, then validation
    // throws in the catch branch *before* any spawn/poll. Asserting this exact
    // message (not "did not start in time") proves the fast-fail path.
    const session = `validate-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    await expect(connectOrSpawn(session)).rejects.toThrow(/invalid BOWSER_BACKEND/);
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
      await expect(connectOrSpawn(session, { spawn: false })).rejects.toThrow(/no daemon/);
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
            if (req.op === "ping") s.write(JSON.stringify({ id: req.id, ok: true, result: "pong" }) + "\n");
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
        expect(await outcomeWithin(client.request("state"), 1000)).toBe(expected);
      } finally {
        client.close();
      }
    } finally {
      server.stop(true);
    }
  });
});
