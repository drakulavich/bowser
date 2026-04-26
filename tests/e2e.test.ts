// End-to-end test against a real headless Chromium.
//
// Skipped by default so the test suite stays green on machines without a
// Chromium install. Enable with BOWSER_E2E=1.
//
//   BOWSER_E2E=1 bun test tests/e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium } from "../src/browser.ts";
import { cmdClick, cmdClose, cmdOpen, cmdSnapshot } from "../src/commands.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: real Chromium", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-e2e-"));
    process.env.HOME = tmp;
    // Sanity-check detection.
    const path = detectChromium();
    if (!path) {
      throw new Error(
        "BOWSER_E2E=1 was set but no Chromium binary was found. " +
          "Install chromium-headless-shell or set BOWSER_CHROMIUM_PATH.",
      );
    }
  });

  afterAll(async () => {
    // Shut down the daemon + Chrome before cleanup so we don't leak processes
    // into the next test file.
    try {
      await cmdClose({ session, json: true });
    } catch {}
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const session = "e2e";

  // Inline HTML served as a data: URL — no network required.
  const html = `
    <html><head><title>Bowser Test</title></head>
    <body>
      <h1>Hi</h1>
      <button id="go">Go</button>
      <input id="name" placeholder="Your name" />
      <a href="#next" id="more">More</a>
    </body></html>`;
  const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);

  test("open → snap → click flow", async () => {
    await cmdOpen({ session, json: true }, dataUrl);

    const yaml = await cmdSnapshot({ session, json: false });
    // The snapshot should find our button, input, and link.
    expect(yaml).toContain("button");
    expect(yaml).toContain("textbox");
    expect(yaml).toContain("link");

    const state = await loadState(session);
    const button = state?.refs.find((r) => r.role === "button");
    expect(button).toBeDefined();

    // Click it — should complete without throwing.
    const out = await cmdClick({ session, json: true }, button!.id);
    expect(JSON.parse(out).ok).toBe(true);
  }, 30_000);
});
