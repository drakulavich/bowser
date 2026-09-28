// Unit tests for decoding what Bun.WebView.screenshot() returns (a Blob).
import { describe, expect, test } from "bun:test";
import { pngBytesFrom } from "../src/browser.ts";
import { maxCaptureHeight, nextAvailablePath } from "../src/commands/snapshot.ts";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("pngBytesFrom", () => {
  test("decodes a Blob to its bytes", async () => {
    const original = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const blob = new Blob([original], { type: "image/png" });
    const out = await pngBytesFrom(blob);
    expect(out).toEqual(original);
  });

  test("decodes a base64 string to its bytes", async () => {
    const original = new Uint8Array(Buffer.from(PNG_B64, "base64"));
    const out = await pngBytesFrom(PNG_B64);
    expect(out).toEqual(original);
  });

  test("the decoded bytes start with the PNG signature", async () => {
    const out = await pngBytesFrom(PNG_B64);
    expect([...out.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe("nextAvailablePath", () => {
  test("returns the base name when it doesn't exist", async () => {
    expect(await nextAvailablePath("shot.png", async () => false)).toBe("shot.png");
  });
  test("increments past existing files until a free name", async () => {
    const taken = new Set(["shot.png", "shot-1.png", "shot-2.png"]);
    expect(await nextAvailablePath("shot.png", async (p) => taken.has(p))).toBe("shot-3.png");
  });
  test("inserts the suffix before the extension", async () => {
    expect(await nextAvailablePath("a/b/screenshot-x.png", async (p) => p === "a/b/screenshot-x.png")).toBe("a/b/screenshot-x-1.png");
  });
  test("handles a name with no extension", async () => {
    expect(await nextAvailablePath("shot", async (p) => p === "shot")).toBe("shot-1");
  });

  test("does not split a leading-dot basename as an extension", async () => {
    expect(await nextAvailablePath("/tmp/.foo", async (p) => p === "/tmp/.foo")).toBe("/tmp/.foo-1");
  });
});

// #69: the tallest viewport WebKit still captures at a given width, against
// the boundaries measured on Bun 1.4.2 at pixel ratio 2 (one fresh view per
// probe): at height 16384 the widest capture is 16368 (16369 fails); at width
// 16384 the tallest is 16383.
describe("maxCaptureHeight", () => {
  test("at width 16384, pixel ratio 2: 16383", () => {
    expect(maxCaptureHeight(16384, 2)).toBe(16383);
  });
  test("at width 16369, pixel ratio 2: 16383 (rows are padded to 32 pixels)", () => {
    expect(maxCaptureHeight(16369, 2)).toBe(16383);
  });
  test("at width 16368, pixel ratio 2: at least 16384, the resize maximum", () => {
    expect(maxCaptureHeight(16368, 2)).toBeGreaterThanOrEqual(16384);
  });
  test("at pixel ratio 1 every resize size fits (the model's prediction; not measured, no ratio-1 display)", () => {
    expect(maxCaptureHeight(16384, 1)).toBeGreaterThanOrEqual(16384);
  });
});
