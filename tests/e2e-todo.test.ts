// End-to-end: drive a small local todo app with the Bowser commands.
// Serves tests/fixtures/todo-app.html with Bun.serve so we exercise real HTTP,
// a real DOM, event handlers, and multi-step interactions.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-todo.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, openBrowser } from "../src/browser.ts";
import { cmdClick, cmdClose, cmdFill, cmdOpen, cmdSnapshot } from "../src/commands.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: local todo app", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: { stop: () => void; url: URL } | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    if (!detectChromium()) {
      throw new Error("no Chromium binary found; install chromium-headless-shell");
    }

    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-todo-"));
    process.env.HOME = tmp;

    const html = await readFile(
      join(import.meta.dir, "fixtures/todo-app.html"),
      "utf8",
    );

    // Serve the fixture on a random port.
    const s = Bun.serve({
      port: 0,
      fetch() {
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    server = { stop: () => s.stop(true), url: s.url };
    baseUrl = s.url.toString();
  });

  afterAll(async () => {
    try {
      await cmdClose({ session, json: true, flags: {} });
    } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const session = "todo";

  test("add, toggle, and clear todos end-to-end", async () => {
    // 1. Open the app.
    await cmdOpen({ session, json: true, flags: {} }, baseUrl);

    // 2. First snapshot — we should see the input, Add button, and Clear button.
    const snap1 = await cmdSnapshot({ session, json: false, flags: {} });
    expect(snap1).toContain('"New todo": [ref=');
    expect(snap1).toContain('"Add": [ref=');
    expect(snap1).toContain('"Clear completed": [ref=');

    const state1 = await loadState(session);
    const inputRef = state1!.refs.find((r) => r.name === "New todo")!;
    const addRef = state1!.refs.find((r) => r.name === "Add")!;
    expect(inputRef).toBeDefined();
    expect(addRef).toBeDefined();

    // 3. Add three todos via fill + click.
    for (const text of ["buy milk", "write tests", "ship bowser"]) {
      await cmdFill({ session, json: true, flags: {} }, inputRef.id, text);
      await cmdClick({ session, json: true, flags: {} }, addRef.id);
      // The form submit re-renders; re-snap so new checkboxes show up.
      await cmdSnapshot({ session, json: false, flags: {} });
    }

    // 4. Verify all three exist on the page via a direct evaluate.
    //    (In a real agent loop you'd just read the next snapshot — doing it
    //    this way here proves the DOM actually updated, not just our YAML.)
    {
      // Use openBrowser so BOWSER_CHROME_ARGS (e.g. --no-sandbox on CI) is
      // honored — a raw `new Bun.WebView(...)` here would bypass it and crash.
      const b = await openBrowser();
      try {
        await b.navigate(baseUrl);
        // Replay the adds since a fresh view has empty state.
        for (const text of ["buy milk", "write tests", "ship bowser"]) {
          await b.click("#new-todo");
          await b.type(text);
          await b.click("#add-btn");
        }
        const items = (await b.evaluate(
          "[...document.querySelectorAll('#list li label')].map(el => el.textContent)",
        )) as string[];
        expect(items).toEqual(["buy milk", "write tests", "ship bowser"]);

        const remaining = await b.evaluate(
          "document.getElementById('count').textContent",
        );
        expect(remaining).toBe("3 items left");
      } finally {
        await b.close();
      }
    }

    // 5. Toggle the first todo via Bowser (checkbox is a new ref after re-snap).
    const snap2 = await cmdSnapshot({ session, json: false, flags: {} });
    expect(snap2).toContain('"Toggle buy milk": [ref=');
    const state2 = await loadState(session);
    const toggleFirst = state2!.refs.find((r) => r.name === "Toggle buy milk")!;
    await cmdClick({ session, json: true, flags: {} }, toggleFirst.id);

    // 6. Click "Clear completed" and verify "buy milk" is gone.
    await cmdSnapshot({ session, json: false, flags: {} });
    const state3 = await loadState(session);
    const clearRef = state3!.refs.find((r) => r.name === "Clear completed")!;
    await cmdClick({ session, json: true, flags: {} }, clearRef.id);

    // Re-snap once more to capture the resulting DOM.
    const snap4 = await cmdSnapshot({ session, json: false, flags: {} });
    expect(snap4).not.toContain('"Toggle buy milk": [ref=');
    expect(snap4).toContain('"Toggle write tests": [ref=');
    expect(snap4).toContain('"Toggle ship bowser": [ref=');
  }, 120_000);
});
