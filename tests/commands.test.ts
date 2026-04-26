// Command-layer tests with a fake daemon client. No real Chromium needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "../src/daemon.ts";
import {
  cmdClick, cmdFill, cmdType, cmdPress, cmdHover, cmdSelect,
  cmdCheck, cmdUncheck, cmdScreenshot, cmdHistory,
  cmdClose, cmdOpen, cmdGoto, cmdSnapshot, cmdList, cmdInstall,
  type CommandContext,
} from "../src/commands.ts";
import { saveState } from "../src/state.ts";

// Minimal DaemonClient stand-in with a scripted response map.
function fakeClient(handlers: {
  navigate?: (url: string) => void;
  evaluate?: (expr: string) => unknown;
  click?: (selector: string) => void;
  type?: (text: string) => void;
  press?: (key: string) => void;
  hover?: (selector: string) => void;
  select?: (selector: string, value: string) => void;
  check?: (selector: string) => void;
  uncheck?: (selector: string) => void;
  screenshot?: (selector?: string, path?: string) => string | undefined;
  back?: () => void;
  forward?: () => void;
  reload?: () => void;
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
        case "press":
          handlers.press?.(args[0] as string);
          return;
        case "hover":
          handlers.hover?.(args[0] as string);
          return;
        case "select":
          handlers.select?.(args[0] as string, args[1] as string);
          return;
        case "check":
          handlers.check?.(args[0] as string);
          return;
        case "uncheck":
          handlers.uncheck?.(args[0] as string);
          return;
        case "screenshot":
          return handlers.screenshot?.(args[0] as string | undefined, args[1] as string | undefined);
        case "back":
          handlers.back?.();
          return;
        case "forward":
          handlers.forward?.();
          return;
        case "reload":
          handlers.reload?.();
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

async function seedRefs() {
  await saveState({
    name: "default",
    url: "https://x",
    title: "X",
    refs: [
      { id: "e1", selector: "a",        role: "link",     name: "Home",  tag: "a" },
      { id: "e2", selector: "input",    role: "textbox",  name: "Email", tag: "input" },
      { id: "e3", selector: "select",   role: "combobox", name: "Color", tag: "select" },
      { id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" },
    ],
    updatedAt: Date.now(),
  });
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

// Wave-2 action command tests — use the shared tmp HOME from beforeAll above.
// seedRefs() writes to session "default"; each test uses its own session via ctx()
// which has its own random session name — we seed "default" just to satisfy
// loadState for the ref-lookup tests (those commands load state by ctx.session,
// so we need to seed the right session name).

describe("click", () => {
  test("dispatches click on selector", async () => {
    // Seed state for the current session so resolveRef works.
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    const out = await cmdClick({ ...ctx(), connect: async () => c }, "e1");
    expect(out).toContain("clicked e1");
    expect(c.calls).toContainEqual(["click", ["a"]]);
  });
});

describe("fill", () => {
  test("clicks, clears, types", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e2", selector: "input", role: "textbox", name: "Email", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    await cmdFill({ ...ctx(), connect: async () => c }, "e2", "hi");
    const ops = c.calls.map((cl) => cl[0]);
    expect(ops).toEqual(["click", "evaluate", "type"]);
  });
});

describe("type", () => {
  test("types into focused element", async () => {
    const c = fakeClient({});
    await cmdType({ ...ctx(), connect: async () => c }, "abc");
    expect(c.calls).toContainEqual(["type", ["abc"]]);
  });
});

describe("press", () => {
  test("presses a key", async () => {
    const c = fakeClient({});
    await cmdPress({ ...ctx(), connect: async () => c }, "Enter");
    expect(c.calls).toContainEqual(["press", ["Enter"]]);
  });
});

describe("hover", () => {
  test("hovers a ref", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    await cmdHover({ ...ctx(), connect: async () => c }, "e1");
    expect(c.calls).toContainEqual(["hover", ["a"]]);
  });
});

describe("select", () => {
  test("selects a value", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e3", selector: "select", role: "combobox", name: "Color", tag: "select" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    await cmdSelect({ ...ctx(), connect: async () => c }, "e3", "red");
    expect(c.calls).toContainEqual(["select", ["select", "red"]]);
  });
});

describe("check / uncheck", () => {
  test("check sends check op", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    await cmdCheck({ ...ctx(), connect: async () => c }, "e4");
    expect(c.calls).toContainEqual(["check", ["input.cb"]]);
  });
  test("uncheck sends uncheck op", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({});
    await cmdUncheck({ ...ctx(), connect: async () => c }, "e4");
    expect(c.calls).toContainEqual(["uncheck", ["input.cb"]]);
  });
});

describe("screenshot", () => {
  test("full-page returns base64 to stdout", async () => {
    const c = fakeClient({ screenshot: () => "BASE64DATA" });
    const out = await cmdScreenshot({ ...ctx(), connect: async () => c }, {});
    expect(out).toBe("BASE64DATA");
  });
  test("--filename writes file", async () => {
    const tmp = `/tmp/bowser-shot-${Date.now()}.png`;
    const c = fakeClient({ screenshot: () => undefined });
    const out = await cmdScreenshot(
      { ...ctx({ flags: { filename: tmp } }), connect: async () => c },
      { filename: tmp },
    );
    expect(out).toBe(`wrote ${tmp}`);
  });
});

describe("history (go-back/go-forward/reload)", () => {
  test("go-back", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "back");
    expect(c.calls).toContainEqual(["back", []]);
  });
  test("go-forward", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "forward");
    expect(c.calls).toContainEqual(["forward", []]);
  });
  test("reload", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "reload");
    expect(c.calls).toContainEqual(["reload", []]);
  });
});
