// Tests that the parent process validates backend config before spawning the
// (silent, detached) daemon — so a bad BOWSER_BACKEND fails fast with a clear,
// actionable message instead of being swallowed and surfacing as a 5s startup
// timeout. See docs/superpowers/specs/2026-06-04-macos-webkit-backend-design.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { connectOrSpawn } from "../src/daemon.ts";

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
