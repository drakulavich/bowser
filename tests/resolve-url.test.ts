// Unit tests for resolveUrl. The page's location.href is the URL: WebKit's
// view.url keeps the old URL after pushState, replaceState or a hash change,
// and is "" before the first navigation, where the page is about:blank.
// view.url is the fallback when the page cannot answer.
import { describe, expect, test } from "bun:test";
import { resolveUrl } from "../src/browser.ts";

describe("resolveUrl", () => {
  test("location.href wins over a non-empty view.url (after pushState)", async () => {
    expect(await resolveUrl("http://x/a", async () => "http://x/pushed")).toBe("http://x/pushed");
  });

  test("a fresh view reads about:blank from the page", async () => {
    expect(await resolveUrl("", async () => "about:blank")).toBe("about:blank");
  });

  test("falls back to view.url when the read throws", async () => {
    expect(await resolveUrl("http://x/a", async () => { throw new Error("eval failed"); })).toBe("http://x/a");
    expect(await resolveUrl("", async () => { throw new Error("eval failed"); })).toBe("");
  });

  test("falls back to view.url when the read yields a non-string", async () => {
    expect(await resolveUrl("http://x/a", async () => undefined)).toBe("http://x/a");
  });

  test("falls back to view.url when the read yields an empty string", async () => {
    expect(await resolveUrl("http://x/a", async () => "")).toBe("http://x/a");
  });
});
