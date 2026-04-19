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
  cmdSnap,
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

describe("cmdOpen", () => {
  test("navigates and saves state", async () => {
    const c = fakeClient({});
    const out = await cmdOpen(
      { session, json: true, connect: async () => c },
      "https://example.com",
    );
    const ops = (c as any).calls.map((x: any[]) => x[0]);
    expect(ops).toContain("navigate");
    expect(ops).toContain("state");
    expect(JSON.parse(out)).toMatchObject({ ok: true, url: "https://example.com" });
  });

  test("errors without URL", async () => {
    await expect(cmdOpen({ session, json: false }, "")).rejects.toThrow(/usage/);
  });
});

describe("cmdSnap", () => {
  test("requires a prior open", async () => {
    await expect(cmdSnap({ session, json: false })).rejects.toThrow(/no open page/);
  });

  test("persists refs and renders YAML", async () => {
    await cmdOpen(
      { session, json: true, connect: async () => fakeClient({}) },
      "https://example.com",
    );

    const c = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        refs: [
          { id: "@e1", selector: "html > body > a", role: "link", name: "More", tag: "a" },
        ],
      }),
    });
    const yaml = await cmdSnap({ session, json: false, connect: async () => c });
    expect(yaml).toContain('url: "https://example.com/"');
    expect(yaml).toContain('{ id: @e1, role: link, name: "More" }');

    const { loadState } = await import("../src/state.ts");
    const state = await loadState(session);
    expect(state?.refs).toHaveLength(1);
    expect(state?.refs[0]?.id).toBe("@e1");
  });
});

describe("cmdClick", () => {
  test("resolves ref and clicks selector", async () => {
    await cmdOpen(
      { session, json: true, connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        refs: [
          { id: "@e1", selector: "html > body > button", role: "button", name: "Go", tag: "button" },
        ],
      }),
    });
    await cmdSnap({ session, json: false, connect: async () => snapC });

    let clicked: string | undefined;
    const clickC = fakeClient({ click: (s) => { clicked = s; } });
    const out = await cmdClick(
      { session, json: true, connect: async () => clickC },
      "@e1",
    );
    expect(clicked).toBe("html > body > button");
    expect(JSON.parse(out).ref).toBe("@e1");
  });

  test("unknown ref throws helpful error", async () => {
    await cmdOpen(
      { session, json: true, connect: async () => fakeClient({}) },
      "https://example.com",
    );
    await expect(cmdClick({ session, json: false }, "@e99")).rejects.toThrow(/not found/);
  });
});

describe("cmdFill", () => {
  test("clicks, clears, and types", async () => {
    await cmdOpen(
      { session, json: true, connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        refs: [
          { id: "@e1", selector: "html > body > input", role: "textbox", name: "Email", tag: "input" },
        ],
      }),
    });
    await cmdSnap({ session, json: false, connect: async () => snapC });

    let clicked = false;
    let typed: string | undefined;
    const fillC = fakeClient({
      click: () => { clicked = true; },
      type: (t) => { typed = t; },
      evaluate: () => undefined,
    });
    await cmdFill(
      { session, json: true, connect: async () => fillC },
      "@e1",
      "bun@bowser.dev",
    );
    expect(clicked).toBe(true);
    expect(typed).toBe("bun@bowser.dev");
  });
});

describe("cmdClose", () => {
  test("clears state when a session exists", async () => {
    await cmdOpen(
      { session, json: true, connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const out = await cmdClose({
      session,
      json: true,
      // No daemon → connect will throw with spawn: false; cmdClose swallows.
      connect: async () => { throw new Error("no daemon"); },
    });
    expect(JSON.parse(out).ok).toBe(true);
    const { loadState } = await import("../src/state.ts");
    const state = await loadState(session);
    expect(state?.url).toBe("");
    expect(state?.refs).toEqual([]);
  });

  test("works when no session exists", async () => {
    const out = await cmdClose({
      session,
      json: false,
      connect: async () => { throw new Error("no daemon"); },
    });
    expect(out).toContain("closed session");
  });
});
