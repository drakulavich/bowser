// Command-layer tests with a fake daemon client. No real Chromium needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { DaemonClient } from "../src/daemon.ts";
import {
  cmdClick, cmdFill, cmdType, cmdPress, cmdHover, cmdSelect,
  cmdCheck, cmdUncheck, cmdScreenshot, cmdHistory,
  cmdClose, cmdOpen, cmdGoto, cmdSnapshot, cmdList, cmdInstall,
  cmdLocalStorageList, cmdLocalStorageGet, cmdLocalStorageSet,
  cmdLocalStorageDelete, cmdLocalStorageClear,
  cmdSessionStorageList, cmdSessionStorageGet, cmdSessionStorageSet,
  cmdSessionStorageDelete, cmdSessionStorageClear,
  type CommandContext,
} from "../src/commands.ts";
import { saveState, loadState } from "../src/state.ts";

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
  screenshot?: (selector?: string) => string;
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
        case "screenshot": {
          // Mirror the real daemon: when given a path, write the PNG and return
          // just { path }; otherwise return base64.
          const path = args[0] as string | undefined;
          const b64 = handlers.screenshot?.(path) ?? "";
          if (path) {
            await Bun.write(path, Buffer.from(b64, "base64"));
            return { path };
          }
          return b64;
        }
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
  test("goto errors when a real URL ends on about:blank", async () => {
    const c = fakeClient({ state: () => ({ url: "about:blank", title: "X" }) });
    await expect(
      cmdGoto({ ...ctx(), connect: async () => c }, "https://example.com/?q=1"),
    ).rejects.toThrow(/did not load/i);
  });
});

describe("open (assertNavigated guard)", () => {
  test("open errors when a real URL ends on about:blank", async () => {
    const c = fakeClient({ state: () => ({ url: "about:blank", title: "" }) });
    await expect(
      cmdOpen({ ...ctx(), connect: async () => c }, "https://example.com/?q=1"),
    ).rejects.toThrow(/did not load/i);
  });

  test("open does NOT throw when the URL resolves correctly", async () => {
    const c = fakeClient({ state: () => ({ url: "https://example.com/?q=1", title: "T" }) });
    const out = await cmdOpen({ ...ctx(), connect: async () => c }, "https://example.com/?q=1");
    expect(out).toContain("https://example.com/?q=1");
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
      { ...ctx(), connect: async () => c },
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
  test("--depth=N is honored — depth=1 flattens nested refs", async () => {
    const c = fakeClient({
      evaluate: () => ({
        url: "https://x", title: "X",
        refs: [
          { id: "e1", selector: "a", role: "link", name: "Home", tag: "a", href: "/",
            path: [{ role: "navigation", name: "Primary" }] },
        ],
      }),
    });
    const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, { depth: "1" });
    // depth=1 → flat. No "navigation" parent line.
    expect(out).not.toContain("navigation");
    expect(out).toContain(`- link "Home": [ref=e1]`);
  });
  test("--depth=0 rejected as user error", async () => {
    const c = fakeClient({
      evaluate: () => ({ url: "u", title: "t", refs: [] }),
    });
    await expect(
      cmdSnapshot({ ...ctx(), connect: async () => c }, { depth: "0" }),
    ).rejects.toThrow(/usage:/);
  });
});

describe("close", () => {
  test("clears state", async () => {
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c });
    expect(out).toContain(`closed session '${session}'`);
  });
  test("closes the session named by the positional, not --session default", async () => {
    const c = fakeClient({});
    // Seed 'dog1' with non-empty state and leave ctx()'s random session absent.
    await saveState({ name: "dog1", url: "u", title: "t", refs: [], updatedAt: 1 });
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { name: "dog1" });
    expect(out).toContain("closed session 'dog1'");
    // 'dog1' state was cleared (emptyState has url ""), ctx session was never touched.
    const closed = await loadState("dog1");
    expect(closed?.url).toBe("");
    expect(await loadState(session)).toBeNull();
  });

  test("--all closes every session under the sessions root", async () => {
    // Seed two sessions on disk (saveState creates ~/.bowser/sessions/<name>/).
    await saveState({ name: "a", url: "x", title: "", refs: [], updatedAt: Date.now() });
    await saveState({ name: "b", url: "y", title: "", refs: [], updatedAt: Date.now() });
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { all: true });
    expect(out).toMatch(/^closed \d+ sessions?: /);
    expect(out).toContain("a");
    expect(out).toContain("b");
    // both were cleared (emptyState url is "")
    expect((await loadState("a"))?.url).toBe("");
    expect((await loadState("b"))?.url).toBe("");
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
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  test("--filename decodes the base64 and writes a real PNG at the given path", async () => {
    const tmpFile = join(tmp, `shot-${Date.now()}.png`);
    const c = fakeClient({ screenshot: () => PNG_B64 });
    const out = await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: tmpFile });
    expect(out).toBe(`wrote ${tmpFile}`);
    const written = new Uint8Array(await Bun.file(tmpFile).arrayBuffer());
    expect([...written.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("no --filename writes a default screenshot-<session>.png in the cwd", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const session = "shotdefault";
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      expect(out).toBe("wrote screenshot-shotdefault.png");
      expect(await Bun.file(join(tmp, "screenshot-shotdefault.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("no --filename auto-increments when the default file already exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const session = "shotinc";
      await Bun.write(join(tmp, "screenshot-shotinc.png"), "existing");
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      expect(out).toBe("wrote screenshot-shotinc-1.png");
      expect(await Bun.file(join(tmp, "screenshot-shotinc-1.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("sends an ABSOLUTE path so the daemon (different cwd) writes to the right place", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c = fakeClient({ screenshot: () => PNG_B64 });
      await cmdScreenshot(
        { session: "shotabs", json: false, connect: async () => c },
        { filename: "rel.png" },
      );
      const call = c.calls.find(([op]) => op === "screenshot")!;
      expect(isAbsolute(call[1][0] as string)).toBe(true);
      // Use process.cwd() after chdir — on macOS mkdtemp returns /var/... but
      // cwd() resolves symlinks to /private/var/..., so we must compare against
      // the resolved form rather than the raw tmp string.
      expect(call[1][0]).toBe(join(process.cwd(), "rel.png"));
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("localstorage", () => {
  test("list returns empty string when no entries", async () => {
    const c = fakeClient({ evaluate: () => ({}) });
    const out = await cmdLocalStorageList({ ...ctx(), connect: async () => c });
    expect(out).toBe("");
  });

  test("list renders k=v lines", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc", theme: "dark" }) });
    const out = await cmdLocalStorageList({ ...ctx(), connect: async () => c });
    expect(out.split("\n").sort()).toEqual(["theme=dark", "token=abc"]);
  });

  test("list --json returns object", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc" }) });
    const out = await cmdLocalStorageList({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ token: "abc" });
  });

  test("get returns raw value", async () => {
    const c = fakeClient({ evaluate: () => "abc" });
    const out = await cmdLocalStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("abc");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.getItem(\"token\")`);
  });

  test("get missing key returns empty string", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdLocalStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("");
  });

  test("get --json includes null for missing key", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdLocalStorageGet({ ...ctx({ json: true }), connect: async () => c }, "missing");
    expect(JSON.parse(out)).toEqual({ ok: true, key: "missing", value: null });
  });

  test("get rejects empty key", async () => {
    await expect(cmdLocalStorageGet(ctx(), "")).rejects.toThrow(/usage:/);
  });

  test("set sends setItem evaluate with JSON-escaped key/value", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageSet(
      { ...ctx(), connect: async () => c },
      "tok",
      `va"l`,
    );
    expect(out).toBe("set tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.setItem(\"tok\", \"va\\\"l\")`);
  });

  test("set rejects missing args", async () => {
    await expect(cmdLocalStorageSet(ctx(), "", "v")).rejects.toThrow(/usage:/);
  });

  test("delete sends removeItem evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageDelete({ ...ctx(), connect: async () => c }, "tok");
    expect(out).toBe("deleted tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.removeItem(\"tok\")`);
  });

  test("clear sends clear evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageClear({ ...ctx(), connect: async () => c });
    expect(out).toBe("cleared");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.clear()`);
  });

  test("clear --json", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageClear({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ ok: true });
  });
});

describe("sessionstorage", () => {
  test("list returns empty string when no entries", async () => {
    const c = fakeClient({ evaluate: () => ({}) });
    const out = await cmdSessionStorageList({ ...ctx(), connect: async () => c });
    expect(out).toBe("");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain("sessionStorage.length");
  });

  test("list renders k=v lines", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc", theme: "dark" }) });
    const out = await cmdSessionStorageList({ ...ctx(), connect: async () => c });
    expect(out.split("\n").sort()).toEqual(["theme=dark", "token=abc"]);
  });

  test("list --json returns object", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc" }) });
    const out = await cmdSessionStorageList({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ token: "abc" });
  });

  test("get returns raw value", async () => {
    const c = fakeClient({ evaluate: () => "abc" });
    const out = await cmdSessionStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("abc");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.getItem(\"token\")`);
  });

  test("get missing key returns empty string", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdSessionStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("");
  });

  test("get --json includes null for missing key", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdSessionStorageGet({ ...ctx({ json: true }), connect: async () => c }, "missing");
    expect(JSON.parse(out)).toEqual({ ok: true, key: "missing", value: null });
  });

  test("get rejects empty key", async () => {
    await expect(cmdSessionStorageGet(ctx(), "")).rejects.toThrow(/usage:/);
  });

  test("set sends setItem evaluate with JSON-escaped key/value", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageSet(
      { ...ctx(), connect: async () => c },
      "tok",
      `va"l`,
    );
    expect(out).toBe("set tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.setItem(\"tok\", \"va\\\"l\")`);
  });

  test("set rejects missing args", async () => {
    await expect(cmdSessionStorageSet(ctx(), "", "v")).rejects.toThrow(/usage:/);
  });

  test("delete sends removeItem evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageDelete({ ...ctx(), connect: async () => c }, "tok");
    expect(out).toBe("deleted tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.removeItem(\"tok\")`);
  });

  test("clear sends clear evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageClear({ ...ctx(), connect: async () => c });
    expect(out).toBe("cleared");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.clear()`);
  });

  test("clear --json", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageClear({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ ok: true });
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
