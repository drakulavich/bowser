// Unit tests for state-save / state-load with an extended fakeClient.
// Exercises the Playwright-compatible storageState round-trip (cookies +
// per-origin localStorage). No real Chromium required.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import {
  cmdStateSave,
  cmdStateLoad,
} from "../src/commands/storage-state.ts";
import { saveState } from "../src/state.ts";
import type { Cookie } from "../src/cdp/types.ts";
import { fakeClient } from "./helpers/fake-client.ts";

// A fully-populated CDP cookie for mapping assertions.
function cdpCookie(over: Partial<Cookie> = {}): Cookie {
  return {
    name: "sid",
    value: "abc123",
    domain: "example.com",
    path: "/",
    expires: 1893456000,
    size: 9,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: "Lax",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors cookie.test.ts HOME-redirect pattern)
// ---------------------------------------------------------------------------
let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-statetest-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

let session: string;
let fileSeq = 0;
beforeEach(() => {
  session = "st-" + Math.random().toString(36).slice(2, 8);
});

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  session,
  json: false,
  ...overrides,
});

function tmpFile(): string {
  return join(tmp, `state-${fileSeq++}.json`);
}

async function seedUrl(url: string) {
  await saveState({ name: session, url, title: "t", refs: [], updatedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// state-save
// ---------------------------------------------------------------------------
describe("state-save", () => {
  test("writes a Playwright-shaped storageState file (cookies + origins)", async () => {
    await seedUrl("https://example.com/app");
    const c = fakeClient({
      state: () => ({ url: "https://example.com/app", title: "App" }),
      "cookie-get-all": () => [cdpCookie()],
      evaluate: () => ({ token: "t1", theme: "dark" }),
    });
    const file = tmpFile();
    await cmdStateSave({ ...ctx(), connect: async () => c }, file);

    const saved = await Bun.file(file).json();
    expect(saved.cookies).toEqual([
      {
        name: "sid",
        value: "abc123",
        domain: "example.com",
        path: "/",
        expires: 1893456000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    expect(saved.origins).toEqual([
      {
        origin: "https://example.com",
        localStorage: [
          { name: "token", value: "t1" },
          { name: "theme", value: "dark" },
        ],
      },
    ]);
  });

  test("captures the whole cookie jar (cookie-get-all called with no url scope)", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      "cookie-get-all": () => [cdpCookie()],
      evaluate: () => ({}),
    });
    await cmdStateSave({ ...ctx(), connect: async () => c }, tmpFile());
    const call = c.calls.find(([op]) => op === "cookie-get-all");
    expect(call).toBeDefined();
    expect(call![1][0]).toBeUndefined();
  });

  test("omits the origins entry when localStorage is empty", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      "cookie-get-all": () => [cdpCookie()],
      evaluate: () => ({}),
    });
    const file = tmpFile();
    await cmdStateSave({ ...ctx(), connect: async () => c }, file);
    const saved = await Bun.file(file).json();
    expect(saved.origins).toEqual([]);
  });

  test("maps non-standard CDP sameSite to Lax", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      "cookie-get-all": () => [cdpCookie({ sameSite: "Unspecified" })],
      evaluate: () => ({}),
    });
    const file = tmpFile();
    await cmdStateSave({ ...ctx(), connect: async () => c }, file);
    const saved = await Bun.file(file).json();
    expect(saved.cookies[0].sameSite).toBe("Lax");
  });

  test("--json reports counts", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      "cookie-get-all": () => [cdpCookie(), cdpCookie({ name: "other" })],
      evaluate: () => ({ a: "1" }),
      state: () => ({ url: "https://example.com/", title: "Example" }),
    });
    const file = tmpFile();
    const out = await cmdStateSave({ ...ctx({ json: true }), connect: async () => c }, file);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, cookies: 2, origins: 1 });
  });

  test("requires a file argument", async () => {
    const c = fakeClient({});
    await expect(
      cmdStateSave({ ...ctx(), connect: async () => c }, ""),
    ).rejects.toThrow(/usage: bowser state-save/);
  });
});

// ---------------------------------------------------------------------------
// state-load
// ---------------------------------------------------------------------------
describe("state-load", () => {
  async function writeStateFile(state: unknown): Promise<string> {
    const file = tmpFile();
    await Bun.write(file, JSON.stringify(state));
    return file;
  }

  test("restores every cookie via cookie-set with domain + path", async () => {
    await seedUrl("https://example.com/");
    const setParams: unknown[] = [];
    const c = fakeClient({
      "cookie-set": (p) => {
        setParams.push(p);
        return { success: true };
      },
      evaluate: () => undefined,
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [
        { name: "sid", value: "abc123", domain: "example.com", path: "/", expires: 1893456000, httpOnly: true, secure: true, sameSite: "Lax" },
      ],
      origins: [],
    });
    await cmdStateLoad({ ...ctx(), connect: async () => c }, file);
    expect(setParams).toEqual([
      {
        name: "sid",
        value: "abc123",
        domain: "example.com",
        path: "/",
        expires: 1893456000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  });

  test("drops a session cookie's -1 expires when restoring", async () => {
    await seedUrl("https://example.com/");
    const setParams: unknown[] = [];
    const c = fakeClient({
      "cookie-set": (p) => {
        setParams.push(p);
        return { success: true };
      },
      evaluate: () => undefined,
    });
    const file = await writeStateFile({
      cookies: [{ name: "s", value: "v", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
      origins: [],
    });
    await cmdStateLoad({ ...ctx(), connect: async () => c }, file);
    expect((setParams[0] as Record<string, unknown>).expires).toBeUndefined();
  });

  test("restores localStorage for the current origin", async () => {
    await seedUrl("https://example.com/");
    const evalExprs: string[] = [];
    const c = fakeClient({
      "cookie-set": () => ({ success: true }),
      evaluate: (e) => {
        evalExprs.push(e);
        return undefined;
      },
      state: () => ({ url: "https://example.com/app", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [],
      origins: [
        { origin: "https://example.com", localStorage: [{ name: "token", value: "t1" }] },
      ],
    });
    await cmdStateLoad({ ...ctx(), connect: async () => c }, file);
    const joined = evalExprs.join("\n");
    expect(joined).toContain("setItem");
    expect(joined).toContain("token");
    expect(joined).toContain("t1");
  });

  test("skips origins that do not match the current page and reports them", async () => {
    await seedUrl("https://example.com/");
    let evalCount = 0;
    const c = fakeClient({
      "cookie-set": () => ({ success: true }),
      evaluate: () => {
        evalCount++;
        return undefined;
      },
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [],
      origins: [
        { origin: "https://other.com", localStorage: [{ name: "k", value: "v" }] },
      ],
    });
    const out = await cmdStateLoad({ ...ctx({ json: true }), connect: async () => c }, file);
    const parsed = JSON.parse(out);
    expect(evalCount).toBe(0);
    expect(parsed.originsSkipped).toBe(1);
  });

  test("--json reports counts", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      "cookie-set": () => ({ success: true }),
      evaluate: () => undefined,
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [{ name: "a", value: "1", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }],
    });
    const out = await cmdStateLoad({ ...ctx({ json: true }), connect: async () => c }, file);
    expect(JSON.parse(out)).toMatchObject({ ok: true, cookies: 1, originsRestored: 1, originsSkipped: 0 });
  });

  test("requires a file argument", async () => {
    const c = fakeClient({});
    await expect(
      cmdStateLoad({ ...ctx(), connect: async () => c }, ""),
    ).rejects.toThrow(/usage: bowser state-load/);
  });

  test("errors clearly when the file is missing", async () => {
    const c = fakeClient({});
    await expect(
      cmdStateLoad({ ...ctx(), connect: async () => c }, join(tmp, "does-not-exist.json")),
    ).rejects.toThrow();
  });
});
