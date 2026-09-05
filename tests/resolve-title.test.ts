// Unit tests for the document.title fallback. On the webkit backend
// view.title is still "" when navigate() resolves, while the page's own
// document.title is already set. Mirrors tests/resolve-url.test.ts.
import { describe, expect, test } from "bun:test";
import { resolveTitle } from "../src/browser.ts";

describe("resolveTitle", () => {
  test("returns view.title unchanged when non-empty (no evaluate)", async () => {
    let called = false;
    const out = await resolveTitle("Kitchen Sink", async () => { called = true; return "x"; });
    expect(out).toBe("Kitchen Sink");
    expect(called).toBe(false);
  });

  test("falls back to document.title when view.title is empty", async () => {
    const out = await resolveTitle("", async () => "Bowser Todo");
    expect(out).toBe("Bowser Todo");
  });

  test("returns empty when evaluate throws", async () => {
    const out = await resolveTitle("", async () => { throw new Error("eval failed"); });
    expect(out).toBe("");
  });

  test("returns empty when evaluate yields a non-string", async () => {
    const out = await resolveTitle("", async () => undefined);
    expect(out).toBe("");
  });
});
