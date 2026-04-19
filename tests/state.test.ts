import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We can't easily override ~/.bowser at runtime without refactoring state.ts
// to accept a root. Instead we verify resolveRef directly (pure) and leave
// I/O to the integration test where a real session dir is fine.

import { resolveRef, type SessionState } from "../src/state.ts";

describe("resolveRef", () => {
  const state: SessionState = {
    name: "t",
    url: "https://x",
    title: "X",
    updatedAt: 0,
    refs: [
      { id: "@e1", selector: "s1", role: "button", name: "Go", tag: "button" },
      { id: "@e2", selector: "s2", role: "textbox", name: "Email", tag: "input" },
    ],
  };

  test("finds existing ref", () => {
    expect(resolveRef(state, "@e2").selector).toBe("s2");
  });

  test("rejects non-ref input", () => {
    expect(() => resolveRef(state, "button.submit")).toThrow(/expected a ref/);
  });

  test("rejects unknown ref", () => {
    expect(() => resolveRef(state, "@e99")).toThrow(/not found/);
  });
});

describe("state roundtrip (real fs)", () => {
  let origHome: string | undefined;
  let tmp: string;

  beforeAll(async () => {
    // Redirect HOME so saveState writes into a temp dir and our test doesn't
    // pollute the real ~/.bowser.
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
      refs: [{ id: "@e1", selector: "a", role: "link", name: "More", tag: "a" }],
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
