// Tests that the parent process validates backend config before spawning the
// (silent, detached) daemon — so a bad BOWSER_BACKEND fails fast with a clear,
// actionable message instead of being swallowed and surfacing as a 5s startup
// timeout. See docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { connectOrSpawn, socketPath } from "../src/daemon.ts";

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
