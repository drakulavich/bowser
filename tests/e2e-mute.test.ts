// End-to-end: media on a page bowser opens plays muted (#227).
//
//   BOWSER_E2E=1 bun test tests/e2e-mute.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";

const E2E = process.env.BOWSER_E2E === "1";
const run = E2E ? describe : describe.skip;

/** A 30 s 8 kHz mono 8-bit WAV tone. */
function wav(): Uint8Array {
  const rate = 8000;
  const n = rate * 30;
  const v = new DataView(new ArrayBuffer(44 + n));
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, "data");
  v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(20 * Math.sin(i / 4)));
  return new Uint8Array(v.buffer);
}

const PAGE = `<!doctype html><title>Media</title>
<audio id="now" src="/tone.wav" autoplay></audio>`;

// An image that never finishes holds load: open answers on the 5 s cap (ET-52).
const HANGING_PAGE = `<!doctype html><title>Hanging</title>
<audio id="now" src="/tone.wav" autoplay></audio><img src="/never.png">`;

/** Once the element is playing: [paused, muted]. */
const playing = (id: string) => `new Promise((r) => {
  const check = () => { const e = document.getElementById(${JSON.stringify(id)}); if (e && !e.paused) r(JSON.stringify([e.paused, e.muted])); else setTimeout(check, 20); };
  check();
})`;

run("e2e: mute", () => {
  const ctx: CommandContext = { session: "227-mute", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let url: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-mute-"));
    process.env.HOME = tmp;
    const tone = wav();
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/tone.wav") return new Response(tone, { headers: { "content-type": "audio/wav" } });
        if (path === "/never.png") return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { "content-type": "image/png" } });
        return new Response(path === "/hanging" ? HANGING_PAGE : PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    url = `http://localhost:${server.port}/`;
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("autoplaying media, on the page and added later, plays muted after open", async () => {
    await cmdOpen(ctx, url);
    expect(await cmdEval(ctx, playing("now"))).toBe("[false,true]");
    await cmdEval(
      ctx,
      "(() => { const a = document.createElement('audio'); a.id = 'late'; a.src = '/tone.wav'; a.autoplay = true; document.body.append(a) })()",
    );
    expect(await cmdEval(ctx, playing("late"))).toBe("[false,true]");
  }, 60_000);

  test("a playing element the page unmutes is muted again", async () => {
    await cmdOpen(ctx, url);
    expect(await cmdEval(ctx, playing("now"))).toBe("[false,true]");
    await cmdEval(ctx, "document.getElementById('now').muted = false");
    const remuted = `new Promise((r) => {
      const check = () => { const e = document.getElementById('now'); if (e.muted) r(JSON.stringify([e.paused, e.muted])); else setTimeout(check, 20); };
      check();
    })`;
    expect(await cmdEval(ctx, remuted)).toBe("[false,true]");
  }, 60_000);

  test("autoplaying media plays muted after an open that the load cap ends", async () => {
    await cmdOpen(ctx, `${url}hanging`);
    expect(await cmdEval(ctx, playing("now"))).toBe("[false,true]");
  }, 60_000);
});
