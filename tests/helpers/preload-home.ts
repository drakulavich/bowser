// Loaded by `bun test` before any test file (bunfig.toml `[test] preload`).
// Every test process starts with HOME in a fresh temporary directory, so a
// test that forgets to redirect HOME writes there, never to the real
// ~/.bowser. A test that sets its own HOME still does; spawned children
// inherit this one unless a test passes another.
//
// The real home stays reachable only by name, BOWSER_TEST_REAL_HOME, for a
// tool that needs it (playwright-cli keeps its browsers there).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.BOWSER_TEST_REAL_HOME === undefined && process.env.HOME) {
  process.env.BOWSER_TEST_REAL_HOME = process.env.HOME;
}
const home = mkdtempSync(join(tmpdir(), "bowser-test-home-"));
process.env.HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
