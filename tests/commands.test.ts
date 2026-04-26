// Command-layer tests with a fake daemon client. No real Chromium needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "../src/daemon.ts";
import {
  cmdClick,
  cmdClose,
  cmdFill,
  cmdOpen,
  cmdGoto,
  cmdSnapshot,
  cmdList,
  cmdInstall,
  type CommandContext,
} from "../src/commands.ts";

// Minimal DaemonClient stand-in with a scripted response map.
function fakeClient(handlers: {
  navigate?: (url: string) => void;
  evaluate?: (expr: string) => unknown;
  click?: (selector: string) => void;
  type?: (text: string) => void;
  state?: () => { url: string; title: string };
}) {
  const calls: Array<[string, unknown[]]> = [];
  let currentUrl = "";
  let currentTitle = "";

  const c: DaemonClient & { calls: typeof calls } = {
    calls,
    async connect() {},
    async request(op: string, args: unknown[] = []) {
      calls.push([op, args]);
      switch (op) {
        case "ping":
          return "pong";
        case "navigate": {
          const url = args[0] as string;
          currentUrl = url;
          currentTitle = "Fake " + url;
          handlers.navigate?.(url);
          return;
        }
        case "evaluate":
          return handlers.evaluate?.(args[0] as string);
        case "click":
          handlers.click?.(args[0] as string);
          return;
        case "type":
          handlers.type?.(args[0] as string);
          return;
        case "state":
          return handlers.state?.() ?? { url: currentUrl, title: currentTitle };
        default:
          return undefined;
      }
    },
    close() {},
  } as unknown as DaemonClient & { calls: typeof calls };
  return c;
}

let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-cmdtest-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

let session: string;
beforeEach(() => { session = "s-" + Math.random().toString(36).slice(2, 8); });

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  session,
  json: false,
  flags: {},
  ...overrides,
});

describe("open", () => {
  test("navigates and saves state", async () => {
    const c = fakeClient({});
    const out = await cmdOpen({ ...ctx(), connect: async () => c }, "https://x");
    expect(out).toContain("opened https://x");
    expect(c.calls).toContainEqual(["navigate", ["https://x"]]);
  });
  test("--json", async () => {
    const c = fakeClient({});
    const out = await cmdOpen({ ...ctx({ json: true }), connect: async () => c }, "https://x");
    expect(JSON.parse(out)).toEqual({ ok: true, url: "https://x", title: "Fake https://x" });
  });
});

describe("goto", () => {
  test("navigates within current session", async () => {
    const c = fakeClient({});
    const out = await cmdGoto({ ...ctx(), connect: async () => c }, "https://y");
    expect(out).toContain("https://y");
    expect(c.calls).toContainEqual(["navigate", ["https://y"]]);
  });
});

describe("snapshot", () => {
  test("emits aria-tree YAML to stdout", async () => {
    const c = fakeClient({
      evaluate: () => ({
        url: "https://x", title: "X",
        refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      }),
    });
    const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, {});
    expect(out).toBe(`- generic:\n  - link "Home": [ref=e1]`);
  });
  test("--filename writes file and prints 'wrote <path>'", async () => {
    const tmp = `/tmp/bowser-snap-${Date.now()}.yml`;
    const c = fakeClient({
      evaluate: () => ({
        url: "https://x", title: "X",
        refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      }),
    });
    const out = await cmdSnapshot(
      { ...ctx({ flags: { filename: tmp } }), connect: async () => c },
      { filename: tmp },
    );
    expect(out).toBe(`wrote ${tmp}`);
    expect(await Bun.file(tmp).text()).toContain("[ref=e1]");
  });
  test("--json emits JSON", async () => {
    const c = fakeClient({
      evaluate: () => ({
        url: "https://x", title: "X",
        refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      }),
    });
    const out = await cmdSnapshot({ ...ctx({ json: true }), connect: async () => c }, {});
    const obj = JSON.parse(out);
    expect(obj.refs[0].ref).toBe("e1");
  });
});

describe("close", () => {
  test("clears state", async () => {
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c });
    expect(out).toContain(`closed session '${session}'`);
  });
});

describe("list", () => {
  test("returns string output (sessions or empty)", async () => {
    const out = await cmdList(ctx());
    expect(typeof out).toBe("string");
  });
});

describe("install", () => {
  test("skips when chromium already detected", async () => {
    let spawned = false;
    const out = await cmdInstall(ctx(), {
      force: false,
      detect: () => "/fake/chromium",
      spawn: async () => { spawned = true; return 0; },
    });
    expect(out).toContain("already available");
    expect(spawned).toBe(false);
  });
});

describe("cmdClick", () => {
  test("resolves ref and clicks selector", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        refs: [
          { id: "e1", selector: "html > body > button", role: "button", name: "Go", tag: "button" },
        ],
      }),
    });
    // Use cmdSnapshot (new name) for setup
    await cmdSnapshot({ ...ctx(), connect: async () => snapC }, {});

    let clicked: string | undefined;
    const clickC = fakeClient({ click: (s) => { clicked = s; } });
    const out = await cmdClick(
      { ...ctx({ json: true }), connect: async () => clickC },
      "e1",
    );
    expect(clicked).toBe("html > body > button");
    expect(JSON.parse(out).ref).toBe("e1");
  });

  test("unknown ref throws helpful error", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    await expect(cmdClick({ ...ctx() }, "e99")).rejects.toThrow(/not found/);
  });
});

describe("cmdFill", () => {
  test("clicks, clears, and types", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        refs: [
          { id: "e1", selector: "html > body > input", role: "textbox", name: "Email", tag: "input" },
        ],
      }),
    });
    await cmdSnapshot({ ...ctx(), connect: async () => snapC }, {});

    let clicked = false;
    let typed: string | undefined;
    const fillC = fakeClient({
      click: () => { clicked = true; },
      type: (t) => { typed = t; },
      evaluate: () => undefined,
    });
    await cmdFill(
      { ...ctx({ json: true }), connect: async () => fillC },
      "e1",
      "bun@bowser.dev",
    );
    expect(clicked).toBe(true);
    expect(typed).toBe("bun@bowser.dev");
  });
});
