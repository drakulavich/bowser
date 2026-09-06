// End-to-end test that a CDP event actually reaches a subscriber through
// openBrowser(), not just through wrapView() against a fake view.
//
// Skipped by default so the test suite stays green on machines without a
// Chromium install. Enable with BOWSER_E2E=1; a chromium binary must also be
// resolvable (BOWSER_CHROMIUM_PATH, `bowser install`'s cache, or a system
// install — see detectChromium()). openBrowser() is called with an explicit
// executablePath, so this always runs against the chrome backend regardless
// of BOWSER_BACKEND.
//
//   BOWSER_E2E=1 \
//     BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
//     bun test tests/e2e-dialog.test.ts

import { describe, expect, test } from "bun:test";

import { detectChromium } from "../src/backend.ts";
import { openBrowser } from "../src/browser.ts";

const E2E = process.env.BOWSER_E2E === "1";
const chromiumPath = E2E ? detectChromium() : undefined;
const runOrSkip = E2E && chromiumPath ? describe : describe.skip;

runOrSkip("e2e: subscribe (chrome backend)", () => {
  test("a CDP event reaches a subscriber on chrome", async () => {
    const b = await openBrowser({ executablePath: chromiumPath });
    try {
      const seen: unknown[] = [];
      expect(b.subscribe("Page.javascriptDialogOpening", (d) => seen.push(d))).toBe(true);
      await b.navigate("data:text/html,<button onclick=\"confirm('sure?')\">go</button>");
      await b.cdp("Page.enable", {});
      b.click("button").catch(() => {});
      await Bun.sleep(2000);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toMatchObject({ message: "sure?", type: "confirm" });
    } finally {
      await b.close();
    }
  }, 30_000);
});
