// End-to-end test against a real WebKit view.
//
// Skipped by default. Enable with BOWSER_E2E=1.
//
//   BOWSER_E2E=1 bun test tests/e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isLikelyPng } from "../src/browser.ts";
import { cmdClick } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdScreenshot, cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: real browser", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-e2e-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    // Shut down the daemon and its browser before cleanup so we don't leak processes
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

  test("screenshot writes a valid, non-truncated PNG file", async () => {
    await cmdOpen({ session, json: false }, `data:text/html,${encodeURIComponent(html)}`);
    const file = join(tmp, "e2e-shot.png");
    const out = await cmdScreenshot({ session, json: false }, { filename: file });
    expect(out).toBe(`wrote ${file}`);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    expect(isLikelyPng(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000); // a real capture, not a stub
  }, 30_000);

  // Spec F17: Bun.WebView captures the viewport, as playwright-cli does by
  // default; the docs say so. A 3000x5000 CSS px page gives a PNG the size
  // of the viewport (at the display's scale), not of the page.
  test("screenshot of a tall page captures the viewport only", async () => {
    const tall = `<html><body style="margin:0"><div style="width:3000px;height:5000px;background:linear-gradient(red,blue)"></div></body></html>`;
    await cmdOpen({ session, json: false }, `data:text/html,${encodeURIComponent(tall)}`);
    const file = join(tmp, "e2e-tall.png");
    await cmdScreenshot({ session, json: false }, { filename: file });
    const png = new DataView(await Bun.file(file).arrayBuffer());
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    const [w, h] = [png.getUint32(16), png.getUint32(20)];
    const [vw, vh, dpr] = JSON.parse(await cmdEval({ session, json: false }, "JSON.stringify([innerWidth, innerHeight, devicePixelRatio])")) as number[];
    expect([w, h]).toEqual([Math.round(vw! * dpr!), Math.round(vh! * dpr!)]);
    expect(h).toBeLessThan(5000 * dpr!);
  }, 30_000);

  test("a >8 KB snapshot response survives the socket (backpressure)", async () => {
    // 500 buttons: each is one ref'd line, so the tree is well over 8 KB.
    const items = Array.from({ length: 500 }, (_, i) => `<button>item-${i}</button>`).join("");
    const big = `<html><head><title>Big</title></head><body>${items}</body></html>`;
    // Served, not a data: URL: this test is about the daemon's reply, so the
    // URL stays short. A long URL is the next test's subject.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(big, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    try {
      await cmdOpen({ session, json: false }, server.url.toString());
      const yaml = await cmdSnapshot({ session, json: false });
      expect(yaml.length).toBeGreaterThan(8192);
      expect(yaml).toContain("item-0");
      expect(yaml).toContain("item-499"); // the tail proves nothing was truncated
    } finally {
      server.stop(true);
    }
  }, 30_000);

  // #63, oven-sh/bun#44134: a reply over 8 KB from the browser host sometimes
  // arrives only with the host's next message. A 17.5 KB data: URL makes two
  // (the navigation's) and `state` reads it back in a third. Under load, 10 in
  // 100 gotos waited out their op budget before the workaround in browser.ts.
  // Sixty in a row pass by chance about once in 500 runs without it.
  test("goto a >8 KB data: URL, 60 times, never waits out its budget", async () => {
    await cmdOpen({ session, json: false }, "data:text/html,start");
    for (let i = 0; i < 60; i++) {
      const head = `data:text/html,<title>long-${i}</title><p>`;
      const url = head + "a".repeat(17_500 - head.length);
      const got = await Promise.race([
        cmdGoto({ session, json: true }, url).then((out) => {
          const at = JSON.parse(out).url as string;
          return at.includes(`long-${i}`) ? "landed" : at.slice(0, 80);
        }),
        Bun.sleep(5000).then(() => `goto ${i} still pending after 5 s`),
      ]);
      expect(got).toBe("landed");
    }
  }, 120_000);
});
