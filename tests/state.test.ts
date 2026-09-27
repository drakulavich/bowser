import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileDir, resolveRef, sessionDir, sessionsRoot, type Ref, type SessionState } from "../src/state.ts";

const state: SessionState = {
  name: "t",
  url: "https://x",
  title: "x",
  refs: [
    { id: "e1", role: "link", name: "Home", tag: "a" },
    { id: "e2", role: "button", name: "Go", tag: "button" },
  ],
  updatedAt: 0,
};

// A Ref has no selector: a ref command reaches its element only through
// liveSelector. Bringing the field back, even optional, fails tsc here.
type NoSelector = "selector" extends keyof Ref ? false : true;
const refHasNoSelector: NoSelector = true;

describe("resolveRef", () => {
  test("resolves bare ref", () => {
    expect(resolveRef(state, "e2")).toEqual({ id: "e2", role: "button", name: "Go", tag: "button" });
  });
  test("rejects ref with @ prefix", () => {
    expect(() => resolveRef(state, "@e2")).toThrow(/expected a ref like 'e1'/);
  });
  test("throws for unknown ref", () => {
    expect(() => resolveRef(state, "e9")).toThrow(/not found/);
  });
});

// A session name arrives from `-s` unfiltered and becomes a directory that
// `close` removes recursively. Containment is checked here, at the one place
// every session path is built.
describe("sessionDir rejects a name that is not one path segment", () => {
  for (const bad of ["..", ".", "", "../../Documents", "a/b", "a\\b", "x\0y"]) {
    test(JSON.stringify(bad), () => {
      expect(() => sessionDir(bad)).toThrow(/session name/);
    });
  }
  test("an ordinary name still resolves under the sessions root", () => {
    expect(sessionDir("s1")).toBe(join(sessionsRoot(), "s1"));
  });
});

// Tests redirect HOME in beforeAll, after src is imported. A path captured at
// module load would keep the real home, and those tests would write to the
// real ~/.bowser while passing (PR #8). The paths must follow HOME per call.
describe("paths under HOME are resolved at call time", () => {
  test("sessionsRoot and profileDir follow a HOME changed after import", () => {
    const orig = process.env.HOME;
    try {
      process.env.HOME = "/tmp/bowser-home-a";
      expect(sessionsRoot()).toBe("/tmp/bowser-home-a/.bowser/sessions");
      expect(profileDir("x")).toBe("/tmp/bowser-home-a/.bowser/profiles/x");
      process.env.HOME = "/tmp/bowser-home-b";
      expect(sessionsRoot()).toBe("/tmp/bowser-home-b/.bowser/sessions");
      expect(profileDir("x")).toBe("/tmp/bowser-home-b/.bowser/profiles/x");
    } finally {
      if (orig !== undefined) process.env.HOME = orig; else delete process.env.HOME;
    }
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
      refs: [{ id: "e1", role: "link", name: "More", tag: "a" }],
    };
    await saveState(s);
    const loaded = await loadState("roundtrip");
    expect(loaded).toEqual(s);
  });

  test("a state.json from 0.8.0, whose refs still carry a selector, loads and resolves", async () => {
    const { loadState, resolveRef, saveState, statePath, ensureSessionDir } = await import("../src/state.ts");
    await ensureSessionDir("old");
    const old = {
      name: "old", url: "https://example.com/", title: "Example", updatedAt: 1,
      refs: [{ id: "e1", selector: "html > body > a", role: "link", name: "More", tag: "a", href: "/more" }],
    };
    await Bun.write(statePath("old"), JSON.stringify(old));
    const loaded = (await loadState("old"))!;
    expect(refHasNoSelector).toBe(true);
    expect(resolveRef(loaded, "e1")).toMatchObject({ id: "e1", role: "link", name: "More", tag: "a", href: "/more" });
    // The next save writes the refs it is given; a snapshot's refs have no selector.
    await saveState({ ...loaded, refs: [{ id: "e1", role: "link", name: "More", tag: "a" }] });
    expect(await Bun.file(statePath("old")).text()).not.toContain("selector");
  });

  test("loadState returns null for missing session", async () => {
    const { loadState } = await import("../src/state.ts");
    expect(await loadState("does-not-exist")).toBeNull();
  });
});
