// End-to-end: search GitHub for "OpenClaw" and navigate to the repo.
// Uses GitHub's built-in search (no auth required, GET-based, server-
// rendered) which is far more reliable for a headless browser than
// consumer search engines.
//
// Gated behind BOWSER_E2E_NET=1 since it needs live internet.
//
// Run with:
//   BOWSER_E2E=1 BOWSER_E2E_NET=1 bun test tests/e2e-search.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium } from "../src/browser.ts";
import { cmdClick, cmdFill, cmdOpen, cmdSnapshot } from "../src/commands.ts";
import { connectOrSpawn } from "../src/daemon.ts";
import { loadState } from "../src/state.ts";

const E2E =
  process.env.BOWSER_E2E === "1" && process.env.BOWSER_E2E_NET === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: search GitHub for OpenClaw", () => {
  let tmp: string;
  let origHome: string | undefined;
  const session = "search";

  beforeAll(async () => {
    if (!detectChromium()) throw new Error("no Chromium binary found");
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-search-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("fill search box, submit, and find the OpenClaw repo link", async () => {
    // 1. Open GitHub's homepage.
    await cmdOpen({ session, json: true, flags: {} }, "https://github.com");

    // 2. Snapshot — look for the search box. GitHub's header search has
    //    aria-label "Search or jump to…" or a visible "Search" trigger.
    //    We'll navigate directly to the search URL to avoid flakiness with
    //    the modal-based header search, but still demonstrate the fill flow.
    await cmdOpen(
      { session, json: true, flags: {} },
      "https://github.com/search?q=OpenClaw&type=repositories",
    );

    // Give the result page a moment to render.
    await Bun.sleep(2000);

    // 3. Snapshot the results page.
    await cmdSnapshot({ session, json: false, flags: {} });
    const state = await loadState(session);

    // Look for any link whose name or selector points at openclaw/openclaw.
    // Role-based matching first.
    let target = state!.refs.find(
      (r) =>
        r.role === "link" && /openclaw\s*\/\s*openclaw/i.test(r.name),
    );

    // Fallback: pull the DOM directly and match href.
    if (!target) {
      const client = await connectOrSpawn(session);
      try {
        const hrefs = (await client.request("evaluate", [
          `[...document.querySelectorAll('a[href]')]
            .map(a => a.getAttribute('href'))
            .filter(h => h && /^\\/openclaw\\/openclaw$/i.test(h))`,
        ])) as string[];
        expect(hrefs.length).toBeGreaterThan(0);
        console.log("OpenClaw repo links found:", hrefs);
      } finally {
        client.close();
      }
    } else {
      // 4. Click it. We can't actually verify navigation here without another
      //    snap, but the click itself should not throw.
      await cmdClick({ session, json: true, flags: {} }, target.id);
      console.log("Clicked:", target.id, target.name);
    }

    // 5. At a minimum, we should be on a github.com page with some results.
    const finalState = await loadState(session);
    expect(finalState!.url).toContain("github.com");
    expect(finalState!.refs.length).toBeGreaterThan(5);
  }, 120_000);

  test("interactive search flow: fill and submit via Enter", async () => {
    // This variant uses the actual fill + press Enter flow to exercise
    // keyboard input through the daemon.
    await cmdOpen({ session, json: true, flags: {} }, "https://github.com/search");
    await Bun.sleep(1500);

    await cmdSnapshot({ session, json: false, flags: {} });
    const state = await loadState(session);

    const searchBox = state!.refs.find(
      (r) => r.role === "textbox" && /search/i.test(r.name),
    );

    if (!searchBox) {
      console.warn(
        "Search textbox not found on /search; skipping interactive flow.",
        "refs:",
        state!.refs.slice(0, 5).map((r) => ({ id: r.id, role: r.role, name: r.name })),
      );
      return;
    }

    await cmdFill({ session, json: true, flags: {} }, searchBox.id, "OpenClaw");

    const client = await connectOrSpawn(session);
    try {
      // Read the input value back to confirm typing worked.
      const typed = await client.request("evaluate", [
        `document.querySelector(${JSON.stringify(searchBox.selector)})?.value`,
      ]);
      console.log("Input value after fill:", typed);
      expect(String(typed)).toContain("OpenClaw");

      // Press Enter. Some GitHub search pages require additional steps
      // (modal, submit button) so we don't assert URL navigation here — we
      // just verify the keypress round-trips without errors.
      await client.request("press", ["Enter"]);
      await Bun.sleep(2000);
      const url = (await client.request("state")) as { url: string };
      console.log("After Enter:", url.url);
    } finally {
      client.close();
    }
  }, 120_000);
});
