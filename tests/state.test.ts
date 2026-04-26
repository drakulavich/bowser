import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("state roundtrip (real fs)", () => {
  let origHome: string | undefined;
  let tmp: string;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-test-"));
    process.env.HOME = tmp;
  });

  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("save and load a session", async () => {
    const { loadState, saveState } = await import("../src/state.ts");
    const s: SessionState = {
      name: "roundtrip",
      url: "https://example.com/",
      title: "Example",
      updatedAt: 123,
      refs: [{ id: "e1", selector: "a", role: "link", name: "More", tag: "a" }],
    };
    await saveState(s);
    const loaded = await loadState("roundtrip");
    expect(loaded).toEqual(s);
  });

  test("loadState returns null for missing session", async () => {
    const { loadState } = await import("../src/state.ts");
    expect(await loadState("does-not-exist")).toBeNull();
  });
});
