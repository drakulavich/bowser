import { describe, expect, test } from "bun:test";
import { resolveRef, type SessionState } from "../src/state.ts";

const state: SessionState = {
  name: "t",
  url: "https://x",
  title: "x",
  refs: [
    { id: "e1", selector: "html > body > a", role: "link", name: "Home", tag: "a" },
    { id: "e2", selector: "html > body > button", role: "button", name: "Go", tag: "button" },
  ],
  updatedAt: 0,
};

describe("resolveRef", () => {
  test("resolves bare ref", () => {
    expect(resolveRef(state, "e2").selector).toBe("html > body > button");
  });
  test("rejects ref with @ prefix", () => {
    expect(() => resolveRef(state, "@e2")).toThrow(/expected a ref like 'e1'/);
  });
  test("throws for unknown ref", () => {
    expect(() => resolveRef(state, "e9")).toThrow(/not found/);
  });
});
