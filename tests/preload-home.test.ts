// The test preload (bunfig.toml, tests/helpers/preload-home.ts) moves HOME to
// a fresh temporary directory before any test file loads, so a test that
// forgets its own HOME cannot write to the real ~/.bowser.

import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { sessionsRoot } from "../src/state.ts";

test("HOME is a temporary directory, not the real home", () => {
  const home = process.env.HOME!;
  expect(process.env.BOWSER_TEST_REAL_HOME).toBeDefined();
  expect(home).not.toBe(process.env.BOWSER_TEST_REAL_HOME!);
  expect(realpathSync(home)).toStartWith(realpathSync(tmpdir()));
  expect(sessionsRoot()).toStartWith(home);
});

test("a spawned child inherits it", async () => {
  const p = Bun.spawn([process.execPath, "-e", "console.log(process.env.HOME)"], { env: process.env, stdout: "pipe" });
  expect((await new Response(p.stdout).text()).trim()).toBe(process.env.HOME!);
});
