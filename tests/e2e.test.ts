// End-to-end test against a real WebKit view.
//
// Skipped by default. Enable with BOWSER_E2E=1.
//
//   BOWSER_E2E=1 bun test tests/e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isLikelyPng, openBrowser } from "../src/browser.ts";
import { cmdClick, cmdResize } from "../src/commands/interaction.ts";
import { reportFailure } from "../src/cli.ts";
import { UserError } from "../src/errors.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval, cmdRunCode } from "../src/commands/scripting.ts";
import { opTimeoutMs } from "../src/budget.ts";
import { cmdScreenshot, cmdSnapshot, maxCaptureHeight } from "../src/commands/snapshot.ts";
import { SNAPSHOT_SCRIPT } from "../src/page-scripts.ts";
import type { SnapshotResult } from "../src/snapshot.ts";
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

  test("screenshot writes a valid, non-truncated PNG file", async () => {
    await cmdOpen({ session, json: false }, `data:text/html,${encodeURIComponent(html)}`);
    const file = join(tmp, "e2e-shot.png");
    const out = await cmdScreenshot({ session, json: false }, { filename: file });
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const ihdr = new DataView(bytes.buffer);
    expect(out).toBe(`wrote ${file} (${ihdr.getUint32(16)}×${ihdr.getUint32(20)})`);
    // #191: the pixel ratio a window gets on this machine (a CI runner has no Retina display).
    console.log(`devicePixelRatio: ${await cmdEval({ session, json: false }, "devicePixelRatio")}`);
    expect(isLikelyPng(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000); // a real capture, not a stub
  }, 30_000);

  test("screenshot --filename=x.jpg writes a JPEG of the size it reports (#197)", async () => {
    await cmdOpen({ session, json: false }, `data:text/html,${encodeURIComponent(html)}`);
    const file = join(tmp, "e2e-shot.jpg");
    const out = await cmdScreenshot({ session, json: false }, { filename: file });
    const { width, height, format } = await Bun.file(file).image().metadata();
    expect(format).toBe("jpeg");
    expect(out).toBe(`wrote ${file} (${width}×${height})`);
    expect(width).toBeGreaterThan(1);
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

  test("screenshot --scale=1 writes the viewport's CSS size", async () => {
    await cmdOpen({ session, json: false }, dataUrl);
    await cmdResize({ session, json: false }, "300", "200");
    try {
      const file = join(tmp, "e2e-scale1.png");
      const out = await cmdScreenshot({ session, json: false }, { filename: file, scale: "1" });
      const png = new DataView(await Bun.file(file).arrayBuffer());
      expect([png.getUint32(16), png.getUint32(20)]).toEqual([300, 200]);
      expect(out).toBe(`wrote ${file} (300×200)`);
    } finally {
      await cmdResize({ session, json: false }, "800", "600");
    }
  }, 30_000);

  test("screenshot --scale above the display's ratio fails and writes nothing", async () => {
    await cmdOpen({ session, json: false }, dataUrl);
    const dpr = Number(await cmdEval({ session, json: false }, "devicePixelRatio"));
    const file = join(tmp, "e2e-scale-high.png");
    const err = await cmdScreenshot({ session, json: false }, { filename: file, scale: String(dpr + 1) }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`screenshot: --scale=${dpr + 1} needs a display at pixel ratio ${dpr + 1} or more; this one is ${dpr}`);
    expect(reportFailure(err).code).toBe(1);
    expect(await Bun.file(file).exists()).toBe(false);
  }, 30_000);

  // #194: text a script inserts after load, in a web font served by `font`.
  // The bytes are not a real font: a failed load settles document.fonts all the same.
  function lateFontPage(font: () => Promise<Response>) {
    return Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/f.ttf"
          ? font()
          : new Response(
              "<style>@font-face{font-family:Late;src:url(/f.ttf);font-display:block}p{font:40px Late}</style>" +
                "<div id=a></div><script>setTimeout(() => { a.innerHTML = '<p>late</p>' }, 300)</script>",
              { headers: { "content-type": "text/html" } },
            ),
    });
  }
  const fontBytes = () => new Response("x", { headers: { "content-type": "font/ttf" } });

  test("screenshot waits for a late font", async () => {
    const server = lateFontPage(async () => {
      await Bun.sleep(3000);
      return fontBytes();
    });
    try {
      await cmdOpen({ session, json: false }, server.url.toString());
      const probe = await cmdRunCode({ session, json: false }, "await new Promise((r) => setTimeout(r, 500)); return document.fonts.status");
      expect(probe).toBe("loading");
      const file = join(tmp, "e2e-late-font.png");
      expect(await cmdScreenshot({ session, json: false }, { filename: file })).not.toContain("fonts still loading");
      expect(await cmdEval({ session, json: false }, "document.fonts.status")).toBe("loaded");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a font that never arrives is reported after 5 s", async () => {
    const server = lateFontPage(() => new Promise<Response>(() => {}));
    try {
      await cmdOpen({ session, json: false }, server.url.toString());
      await cmdRunCode({ session, json: false }, "await new Promise((r) => setTimeout(r, 500)); return 0");
      const file = join(tmp, "e2e-no-font.png");
      const started = performance.now();
      const out = await cmdScreenshot({ session, json: false }, { filename: file });
      expect(performance.now() - started).toBeLessThan(8000);
      expect(out).toEndWith("; fonts still loading");
      expect(await Bun.file(file).exists()).toBe(true);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  // #69: at the largest viewport resize accepts, WebKit's capture fails with
  // "An unknown error occurred" (exit 2). screenshot names the limit and a
  // size that fits instead, and exits 1.
  test("screenshot of a viewport too large to capture says what to resize to", async () => {
    await cmdOpen({ session, json: false }, dataUrl);
    await cmdResize({ session, json: false }, "16384", "16384");
    try {
      const [vw, , dpr] = JSON.parse(await cmdEval({ session, json: false }, "JSON.stringify([innerWidth, innerHeight, devicePixelRatio])")) as number[];
      // Only a display at pixel ratio 2 reaches the limit through resize: at
      // ratio 1, 16384x16384 is 1 GiB of pixels, and capturing that is slow
      // and not what this test is about. Not measured at ratio 1 (#69).
      if (dpr! < 2) return;
      const err = await cmdScreenshot({ session, json: false }, { filename: join(tmp, "e2e-huge.png") }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as Error).message).toContain(`run 'bowser resize ${vw} ${maxCaptureHeight(vw!, dpr!)}' or smaller`);
      expect(reportFailure(err).code).toBe(1);
    } finally {
      await cmdResize({ session, json: false }, "800", "600");
    }
  }, 60_000);

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
        Bun.sleep((opTimeoutMs() || 30_000) / 2).then(() => `goto ${i} still pending at half its budget`),
      ]);
      expect(got).toBe("landed");
    }
  }, 120_000);

  // A navigation the page starts to a long URL. WebKit refuses a link to a
  // data: URL, so this one is served. Measured without the workaround, 0 of
  // 500 such clicks stalled (the host sends one large frame for them, not
  // navigate()'s two), so this pins the path rather than the bug.
  test("a link click to a >8 KB URL lands, 20 times, within half its budget each", async () => {
    const q = "a".repeat(17_000);
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        const body = u.pathname === "/long" ? "<title>long</title><p>landed</p>" : `<title>start</title><a href="/long?${u.searchParams.get("i")}-${q}">go</a>`;
        return new Response(body, { headers: { "content-type": "text/html" } });
      },
    });
    try {
      for (let i = 0; i < 20; i++) {
        await cmdOpen({ session, json: false }, `${server.url}?i=${i}`);
        await cmdSnapshot({ session, json: false });
        const link = (await loadState(session))?.refs.find((r) => r.role === "link");
        const got = await Promise.race([
          cmdClick({ session, json: false }, link!.id).then(async () => (await loadState(session))?.url ?? ""),
          Bun.sleep((opTimeoutMs() || 30_000) / 2).then(() => `click ${i} still pending at half its budget`),
        ]);
        expect(got).toContain(`/long?${i}-aaa`);
      }
    } finally {
      server.stop(true);
    }
  }, 120_000);

  // The workaround's second view costs a WebContent process; a session that
  // never meets the bug must not open it. The view opens once a call has been
  // pending STALL_MS (1 s, src/browser.ts), which a loaded runner can reach
  // on a short URL too, so a call that slow counts as meeting it.
  test("a session on short URLs never opens the kick view", async () => {
    const b = await openBrowser();
    let slowest = 0;
    const timed = async (p: Promise<unknown>) => {
      const t0 = Date.now();
      await p;
      slowest = Math.max(slowest, Date.now() - t0);
    };
    try {
      await timed(b.navigate(`data:text/html,${encodeURIComponent(html)}`));
      let doc = "";
      await timed(b.evaluate(SNAPSHOT_SCRIPT).then((snap) => (doc = (snap as SnapshotResult).doc)));
      await timed(b.click("#go", undefined, doc));
      await timed(b.click("#more", undefined, doc));
      await timed(b.realUrl());
      await timed(b.screenshot());
      await Bun.sleep(1500);
      if (slowest < 1000) expect(b.kickerOpened).toBe(false);
    } finally {
      await b.close();
    }
  }, 30_000);
});
