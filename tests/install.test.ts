// Tests for `bowser install` — covers the command's skip-when-already-installed
// path and the fake-spawn path that exercises PLAYWRIGHT_BROWSERS_PATH routing
// without actually downloading ~200MB of Chrome.
//
// The real end-to-end "does it actually download" check lives in CI
// (.github/workflows/test.yml) which calls `bowser install` before the e2e
// jobs run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bowserCacheRoot } from "../src/browser.ts";
import { cmdInstall } from "../src/commands.ts";

describe("cmdInstall", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmp = join(tmpdir(), `bowser-install-${Date.now()}-${Math.random()}`);
    await mkdir(tmp, { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    delete process.env.BOWSER_CHROMIUM_PATH;
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("skips when chromium already detected (BOWSER_CHROMIUM_PATH set)", async () => {
    // Point at any file that exists so detectChromium() returns truthy.
    process.env.BOWSER_CHROMIUM_PATH = "/bin/sh";
    let spawned = false;
    const out = await cmdInstall(
      { session: "default", json: true },
      {
        spawn: async () => {
          spawned = true;
          return 0;
        },
      },
    );
    expect(spawned).toBe(false);
    const parsed = JSON.parse(out);
    expect(parsed.skipped).toBe(true);
    expect(parsed.path).toBe("/bin/sh");
  });

  test("--force bypasses the skip and invokes the installer", async () => {
    process.env.BOWSER_CHROMIUM_PATH = "/bin/sh";

    const seen: { cmd?: string[]; env?: Record<string, string> } = {};
    // The fake spawn simulates Playwright by creating the expected binary
    // layout under PLAYWRIGHT_BROWSERS_PATH.
    const fakeSpawn = async (cmd: string[], env: Record<string, string>) => {
      seen.cmd = cmd;
      seen.env = env;
      const stub = `${env.PLAYWRIGHT_BROWSERS_PATH}/chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell`;
      await mkdir(stub.substring(0, stub.lastIndexOf("/")), { recursive: true });
      await Bun.write(stub, "#!/bin/sh\n");
      return 0;
    };

    // Force install — but detect() will still hit /bin/sh first; temporarily
    // unset BOWSER_CHROMIUM_PATH so detection relies on the cache dir.
    delete process.env.BOWSER_CHROMIUM_PATH;

    const out = await cmdInstall(
      { session: "default", json: true },
      { force: true, spawn: fakeSpawn },
    );

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toContain(bowserCacheRoot());
    expect(seen.cmd?.join(" ")).toContain("playwright install --only-shell chromium");
    expect(seen.env?.PLAYWRIGHT_BROWSERS_PATH).toBe(bowserCacheRoot());
  });

  test("propagates installer failure", async () => {
    // Use --force so we always reach the spawn, even if a system chromium
    // exists on the test machine.
    await expect(
      cmdInstall(
        { session: "default", json: true },
        { force: true, spawn: async () => 1 },
      ),
    ).rejects.toThrow(/exited with code 1/);
  });
});
