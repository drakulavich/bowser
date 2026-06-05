// Unit tests for decoding what Bun.WebView.screenshot() returns (a Blob).
import { describe, expect, test } from "bun:test";
import { pngBytesFrom } from "../src/browser.ts";

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
