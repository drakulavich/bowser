// Unit tests for cookie-* commands with an extended fakeClient.
// No real Chromium required.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "../src/daemon.ts";
import {
  cmdCookieList,
  cmdCookieGet,
  cmdCookieSet,
  cmdCookieDelete,
  cmdCookieClear,
  type CommandContext,
} from "../src/commands.ts";
import { saveState } from "../src/state.ts";
import type { Cookie } from "../src/cdp/types.ts";

// ---------------------------------------------------------------------------
// Extended fakeClient — adds the four cookie ops on top of the base handlers
// ---------------------------------------------------------------------------
function fakeCookieClient(handlers: {
  "cookie-get-all"?: (urls?: string[]) => Cookie[];
  "cookie-set"?: (param: unknown) => { success: boolean };
  "cookie-delete"?: (name: string, opts: unknown) => void;
  "cookie-clear"?: () => void;
  state?: () => { url: string; title: string };
}) {
  const calls: Array<[string, unknown[]]> = [];

  const c: DaemonClient & { calls: typeof calls } = {
    calls,
    async connect() {},
    async request(op: string, args: unknown[] = []) {
      calls.push([op, args]);
      switch (op) {
        case "ping":
          return "pong";
        case "state":
          return handlers.state?.() ?? { url: "https://example.com/", title: "Example" };
        case "cookie-get-all":
          return handlers["cookie-get-all"]?.(args[0] as string[] | undefined) ?? [];
        case "cookie-set":
          return handlers["cookie-set"]?.(args[0]) ?? { success: true };
        case "cookie-delete":
          handlers["cookie-delete"]?.(args[0] as string, args[1] ?? {});
          return undefined;
        case "cookie-clear":
          handlers["cookie-clear"]?.();
          return undefined;
        default:
          return undefined;
      }
    },
    close() {},
  } as unknown as DaemonClient & { calls: typeof calls };
  return c;
}

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors commands.test.ts HOME-redirect pattern)
// ---------------------------------------------------------------------------
let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-cookietest-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

let session: string;
beforeEach(() => {
  session = "cs-" + Math.random().toString(36).slice(2, 8);
});

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  session,
  json: false,
  ...overrides,
});

// Seed session state so commands that default the URL to the current page work.
async function seedState(url = "https://example.com/") {
  await saveState({ name: session, url, title: "Example", refs: [], updatedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// cookie-list
// ---------------------------------------------------------------------------
describe("cookie-list", () => {
  const cookies: Cookie[] = [
    {
      name: "sid", value: "abc123", domain: "example.com", path: "/",
      expires: -1, size: 9, httpOnly: true, secure: true, session: true, sameSite: "Lax",
    },
    {
      name: "theme", value: "dark", domain: "example.com", path: "/",
      expires: -1, size: 9, httpOnly: false, secure: false, session: true, sameSite: "Lax",
    },
  ];

  test("text mode: prints name=value per line", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => cookies });
    const out = await cmdCookieList({ ...ctx(), connect: async () => c });
    expect(out).toBe("sid=abc123\ntheme=dark");
  });

  test("--json returns full CDP cookie shape", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => cookies });
    const out = await cmdCookieList({ ...ctx({ json: true }), connect: async () => c });
    const parsed = JSON.parse(out) as Cookie[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ name: "sid", httpOnly: true });
    expect(parsed[1]).toMatchObject({ name: "theme", httpOnly: false });
  });

  test("text mode: empty list returns empty string", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => [] });
    const out = await cmdCookieList({ ...ctx(), connect: async () => c });
    expect(out).toBe("");
  });

  test("--domain flag passes urls based on domain to daemon", async () => {
    const c = fakeCookieClient({ "cookie-get-all": (urls) => {
      // should receive a url built from the domain
      expect(urls).toBeDefined();
      return cookies;
    }});
    await cmdCookieList({ ...ctx(), connect: async () => c }, { domain: "example.com" });
    // The first cookie-get-all call should have args[0] as a urls array
    const call = c.calls.find(([op]) => op === "cookie-get-all");
    expect(call).toBeDefined();
    expect(Array.isArray(call![1][0])).toBe(true);
  });

  test("--url flag passes that url directly", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => [] });
    await cmdCookieList({ ...ctx(), connect: async () => c }, { url: "https://other.com/" });
    const call = c.calls.find(([op]) => op === "cookie-get-all");
    expect((call![1][0] as string[]).includes("https://other.com/")).toBe(true);
  });

  test("default (no flags): uses current page URL from daemon state op", async () => {
    // The fake client's state handler returns "https://example.com/" by default.
    const c = fakeCookieClient({
      "cookie-get-all": () => [],
      state: () => ({ url: "https://example.com/page", title: "Page" }),
    });
    await cmdCookieList({ ...ctx(), connect: async () => c });
    const call = c.calls.find(([op]) => op === "cookie-get-all");
    // Should have queried by current page URL from the live state op
    const urls = call![1][0] as string[];
    expect(urls).toBeDefined();
    expect(urls[0]).toBe("https://example.com/page");
  });
});

// ---------------------------------------------------------------------------
// cookie-get
// ---------------------------------------------------------------------------
describe("cookie-get", () => {
  const cookies: Cookie[] = [
    {
      name: "sid", value: "abc123", domain: "example.com", path: "/",
      expires: -1, size: 9, httpOnly: true, secure: true, session: true,
    },
  ];

  test("found: prints value in text mode", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => cookies });
    const out = await cmdCookieGet({ ...ctx(), connect: async () => c }, "sid");
    expect(out).toBe("abc123");
  });

  test("not found: prints empty string in text mode", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => [] });
    const out = await cmdCookieGet({ ...ctx(), connect: async () => c }, "missing");
    expect(out).toBe("");
  });

  test("found: --json returns {ok:true, cookie}", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => cookies });
    const out = await cmdCookieGet({ ...ctx({ json: true }), connect: async () => c }, "sid");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.cookie).toMatchObject({ name: "sid", value: "abc123", httpOnly: true });
  });

  test("not found: --json returns {ok:false}", async () => {
    const c = fakeCookieClient({ "cookie-get-all": () => [] });
    const out = await cmdCookieGet({ ...ctx({ json: true }), connect: async () => c }, "gone");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.cookie).toBeUndefined();
  });

  test("missing name throws usage error", async () => {
    await expect(cmdCookieGet(ctx(), "")).rejects.toThrow(/^usage: bowser cookie-get/);
  });
});

// ---------------------------------------------------------------------------
// cookie-set
// ---------------------------------------------------------------------------
describe("cookie-set", () => {
  test("basic set passes name/value/url to daemon", async () => {
    await seedState("https://example.com/");
    let received: unknown;
    const c = fakeCookieClient({
      "cookie-set": (p) => { received = p; return { success: true }; },
    });
    const out = await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "tok", "val123",
    );
    expect(out).toContain("set tok");
    expect((received as { name: string }).name).toBe("tok");
    expect((received as { value: string }).value).toBe("val123");
    // url should default to current page url
    expect((received as { url?: string }).url).toBeDefined();
  });

  test("--http-only passes httpOnly:true", async () => {
    await seedState("https://example.com/");
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "sid", "s3cr3t",
      { httpOnly: true },
    );
    expect((received as { httpOnly?: boolean }).httpOnly).toBe(true);
  });

  test("--secure passes secure:true", async () => {
    await seedState("https://example.com/");
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "s", "v",
      { secure: true },
    );
    expect((received as { secure?: boolean }).secure).toBe(true);
  });

  test("--same-site passes sameSite", async () => {
    await seedState("https://example.com/");
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "s", "v",
      { sameSite: "Strict" },
    );
    expect((received as { sameSite?: string }).sameSite).toBe("Strict");
  });

  test("--expires passes expires as number", async () => {
    await seedState("https://example.com/");
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "s", "v",
      { expires: 9999999999 },
    );
    expect((received as { expires?: number }).expires).toBe(9999999999);
  });

  test("--domain uses domain instead of url", async () => {
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "s", "v",
      { domain: "example.com" },
    );
    expect((received as { domain?: string }).domain).toBe("example.com");
    expect((received as { url?: string }).url).toBeUndefined();
  });

  test("--url overrides default page url", async () => {
    await seedState("https://page.com/");
    let received: unknown;
    const c = fakeCookieClient({ "cookie-set": (p) => { received = p; return { success: true }; } });
    await cmdCookieSet(
      { ...ctx(), connect: async () => c },
      "s", "v",
      { url: "https://other.com/" },
    );
    expect((received as { url?: string }).url).toBe("https://other.com/");
  });

  test("--json returns {ok:true}", async () => {
    await seedState("https://example.com/");
    const c = fakeCookieClient({ "cookie-set": () => ({ success: true }) });
    const out = await cmdCookieSet(
      { ...ctx({ json: true }), connect: async () => c },
      "k", "v",
    );
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  test("missing name throws usage error", async () => {
    await expect(cmdCookieSet(ctx(), "", "v")).rejects.toThrow(/^usage: bowser cookie-set/);
  });

  test("missing value throws usage error", async () => {
    await expect(cmdCookieSet(ctx(), "k", undefined as unknown as string)).rejects.toThrow(/^usage: bowser cookie-set/);
  });
});

// ---------------------------------------------------------------------------
// cookie-delete
// ---------------------------------------------------------------------------
describe("cookie-delete", () => {
  test("passes name to daemon", async () => {
    let deleteName: string | undefined;
    const c = fakeCookieClient({
      "cookie-delete": (name) => { deleteName = name; },
    });
    const out = await cmdCookieDelete({ ...ctx(), connect: async () => c }, "sid");
    expect(out).toContain("deleted sid");
    expect(deleteName).toBe("sid");
  });

  test("--domain and --path forwarded in opts", async () => {
    let receivedOpts: unknown;
    const c = fakeCookieClient({
      "cookie-delete": (_, opts) => { receivedOpts = opts; },
    });
    await cmdCookieDelete(
      { ...ctx(), connect: async () => c },
      "sid",
      { domain: "example.com", path: "/admin" },
    );
    expect((receivedOpts as { domain?: string }).domain).toBe("example.com");
    expect((receivedOpts as { path?: string }).path).toBe("/admin");
  });

  test("--url forwarded in opts", async () => {
    let receivedOpts: unknown;
    const c = fakeCookieClient({
      "cookie-delete": (_, opts) => { receivedOpts = opts; },
    });
    await cmdCookieDelete(
      { ...ctx(), connect: async () => c },
      "sid",
      { url: "https://example.com/page" },
    );
    expect((receivedOpts as { url?: string }).url).toBe("https://example.com/page");
  });

  test("--json returns {ok:true}", async () => {
    const c = fakeCookieClient({ "cookie-delete": () => {} });
    const out = await cmdCookieDelete(
      { ...ctx({ json: true }), connect: async () => c },
      "sid",
    );
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  test("missing name throws usage error", async () => {
    await expect(cmdCookieDelete(ctx(), "")).rejects.toThrow(/^usage: bowser cookie-delete/);
  });
});

// ---------------------------------------------------------------------------
// cookie-clear
// ---------------------------------------------------------------------------
describe("cookie-clear", () => {
  test("calls cookie-clear op and returns 'cleared'", async () => {
    let cleared = false;
    const c = fakeCookieClient({ "cookie-clear": () => { cleared = true; } });
    const out = await cmdCookieClear({ ...ctx(), connect: async () => c });
    expect(out).toBe("cleared");
    expect(cleared).toBe(true);
  });

  test("--json returns {ok:true}", async () => {
    const c = fakeCookieClient({ "cookie-clear": () => {} });
    const out = await cmdCookieClear({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// WebKit error surfaced
// ---------------------------------------------------------------------------
describe("webkit error", () => {
  test("webkit error propagates as thrown Error with chrome-backend wording", async () => {
    const webkitError = new Error(
      "cookie commands require the chrome backend " +
      "(run 'bowser install' and set BOWSER_BACKEND=chrome, " +
      "or rely on the bowser-managed Chromium)",
    );
    const c = fakeCookieClient({
      "cookie-get-all": () => { throw webkitError; },
    });
    await expect(
      cmdCookieList({ ...ctx(), connect: async () => c }),
    ).rejects.toThrow(/cookie commands require the chrome backend/);
  });
});

// ---------------------------------------------------------------------------
// Flag parsing via CLI schemas (parse the flag strings, not the commands)
// ---------------------------------------------------------------------------
describe("flag parsing (schema-level)", () => {
  test("--http-only is a boolean flag", async () => {
    // Verify the schema accepts --http-only as a boolean flag by exercising
    // the run() entrypoint's parse path. We do this by calling the command with
    // explicit option objects — flag parsing is already tested in parse-args.test.ts.
    // Here we just confirm the command layer accepts the option object shape.
    await seedState("https://example.com/");
    const c = fakeCookieClient({ "cookie-set": () => ({ success: true }) });
    // Should not throw.
    await expect(
      cmdCookieSet({ ...ctx(), connect: async () => c }, "k", "v", { httpOnly: true }),
    ).resolves.toBeDefined();
  });

  test("--same-site accepts Strict/Lax/None values", async () => {
    await seedState("https://example.com/");
    for (const val of ["Strict", "Lax", "None"] as const) {
      const c = fakeCookieClient({ "cookie-set": () => ({ success: true }) });
      await expect(
        cmdCookieSet({ ...ctx(), connect: async () => c }, "k", "v", { sameSite: val }),
      ).resolves.toBeDefined();
    }
  });
});
