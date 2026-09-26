// Unit tests for the location.href URL-resolution fallback. WebKit's
// view.url is "" before the first navigation, where the page is about:blank.
import { describe, expect, test } from "bun:test";
import { resolveUrl } from "../src/browser.ts";

describe("resolveUrl", () => {
  test("returns view.url unchanged when it is set (no evaluate)", async () => {
    let called = false;
    const out = await resolveUrl("https://example.com/?q=1", async () => { called = true; return "x"; });
    expect(out).toBe("https://example.com/?q=1");
    expect(called).toBe(false);
  });

  test("takes about:blank from view.url as it is", async () => {
    let called = false;
    expect(await resolveUrl("about:blank", async () => { called = true; return "x"; })).toBe("about:blank");
    expect(called).toBe(false);
  });

  test("falls back to location.href when view.url is empty", async () => {
    expect(await resolveUrl("", async () => "about:blank")).toBe("about:blank");
  });

  test("returns the original url when evaluate throws", async () => {
    expect(await resolveUrl("", async () => { throw new Error("eval failed"); })).toBe("");
  });

  test("returns the original url when evaluate yields a non-string", async () => {
    expect(await resolveUrl("", async () => undefined)).toBe("");
  });

  test("returns the original url when evaluate yields an empty string", async () => {
    expect(await resolveUrl("", async () => "")).toBe("");
  });
});
