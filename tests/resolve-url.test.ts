// Unit tests for the location.href URL-resolution fallback.
import { describe, expect, test } from "bun:test";
import { resolveUrl } from "../src/browser.ts";

describe("resolveUrl", () => {
  test("returns view.url unchanged when it's a real URL (no evaluate)", async () => {
    let called = false;
    const out = await resolveUrl("https://example.com/?q=1", async () => { called = true; return "x"; });
    expect(out).toBe("https://example.com/?q=1");
    expect(called).toBe(false);
  });

  test("falls back to location.href when view.url is about:blank", async () => {
    const out = await resolveUrl("about:blank", async () => "https://real.example/?q=1");
    expect(out).toBe("https://real.example/?q=1");
  });

  test("falls back to location.href when view.url is empty", async () => {
    const out = await resolveUrl("", async () => "https://real.example/");
    expect(out).toBe("https://real.example/");
  });

  test("returns the original url when evaluate throws", async () => {
    const out = await resolveUrl("about:blank", async () => { throw new Error("eval failed"); });
    expect(out).toBe("about:blank");
  });

  test("returns the original url when evaluate yields a non-string", async () => {
    const out = await resolveUrl("about:blank", async () => undefined);
    expect(out).toBe("about:blank");
  });

  test("returns the original url when evaluate yields an empty string", async () => {
    const out = await resolveUrl("about:blank", async () => "");
    expect(out).toBe("about:blank");
  });
});
