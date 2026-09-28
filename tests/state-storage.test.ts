// Unit tests for state-save / state-load with the fake daemon client: a
// Playwright-compatible storageState file with per-origin localStorage.
// bowser has no cookie access on WebKit, so the file's cookies are always
// written empty and ignored, with a note on stderr, when loaded.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdStateLoad, cmdStateSave } from "../src/commands/storage-state.ts";
import { saveState } from "../src/state.ts";
import { UserError } from "../src/errors.ts";
import { fakeClient } from "./helpers/fake-client.ts";

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
let stderr: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
  session = "st-" + Math.random().toString(36).slice(2, 8);
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
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

const ops = (c: ReturnType<typeof fakeClient>) => c.calls.map(([op]) => op);

describe("state-save", () => {
  test("writes a Playwright-shaped storageState file: no cookies, the page's localStorage", async () => {
    await seedUrl("https://example.com/app");
    const c = fakeClient({
      state: () => ({ url: "https://example.com/app", title: "App" }),
      evaluate: () => ({ token: "t1", theme: "dark" }),
    });
    const file = tmpFile();
    const out = await cmdStateSave({ ...ctx(), connect: async () => c }, file);

    expect(out).toBe(`saved ${file}`);
    expect(await Bun.file(file).json()).toEqual({
      cookies: [],
      origins: [
        {
          origin: "https://example.com",
          localStorage: [
            { name: "token", value: "t1" },
            { name: "theme", value: "dark" },
          ],
        },
      ],
    });
    expect(ops(c)).toEqual(["state", "evaluate"]);
  });

  test("omits the origins entry when localStorage is empty", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({ evaluate: () => ({}) });
    const file = tmpFile();
    await cmdStateSave({ ...ctx(), connect: async () => c }, file);
    expect(await Bun.file(file).json()).toEqual({ cookies: [], origins: [] });
  });

  test("--json reports the origin count", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      evaluate: () => ({ a: "1" }),
      state: () => ({ url: "https://example.com/", title: "Example" }),
    });
    const file = tmpFile();
    const out = await cmdStateSave({ ...ctx({ json: true }), connect: async () => c }, file);
    expect(JSON.parse(out)).toEqual({ ok: true, file, origins: 1 });
  });

  test("requires a file argument", async () => {
    const c = fakeClient({});
    await expect(cmdStateSave({ ...ctx(), connect: async () => c }, "")).rejects.toThrow(/usage: bowser state-save/);
  });
});

describe("state-load", () => {
  async function writeStateFile(state: unknown): Promise<string> {
    const file = tmpFile();
    await Bun.write(file, JSON.stringify(state));
    return file;
  }

  const cookie = (name: string) => ({ name, value: "v", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" });

  test("restores localStorage for the current origin", async () => {
    await seedUrl("https://example.com/");
    const evalExprs: string[] = [];
    const c = fakeClient({
      evaluate: (e) => {
        evalExprs.push(e);
        return undefined;
      },
      state: () => ({ url: "https://example.com/app", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "t1" }] }],
    });
    const out = await cmdStateLoad({ ...ctx(), connect: async () => c }, file);
    expect(out).toBe(`loaded ${file} (1 origin(s))`);
    const joined = evalExprs.join("\n");
    expect(joined).toContain("setItem");
    expect(joined).toContain("token");
    expect(joined).toContain("t1");
    expect(stderr).not.toHaveBeenCalled();
  });

  test("ignores the file's cookies, restores localStorage anyway, and says so on one stderr line", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      evaluate: () => undefined,
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [cookie("a"), cookie("b")],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }],
    });
    const out = await cmdStateLoad({ ...ctx(), connect: async () => c }, file);
    expect(out).toBe(`loaded ${file} (1 origin(s))`);
    expect(ops(c)).toEqual(["state", "evaluate"]);
    expect(stderr.mock.calls).toEqual([
      ["2 cookies skipped (bowser has no cookie access on WebKit; use open --persistent)"],
    ]);
  });

  test("skips origins that do not match the current page and reports them", async () => {
    await seedUrl("https://example.com/");
    let evalCount = 0;
    const c = fakeClient({
      evaluate: () => {
        evalCount++;
        return undefined;
      },
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [],
      origins: [{ origin: "https://other.com", localStorage: [{ name: "k", value: "v" }] }],
    });
    const out = await cmdStateLoad({ ...ctx({ json: true }), connect: async () => c }, file);
    expect(evalCount).toBe(0);
    expect(JSON.parse(out).originsSkipped).toBe(1);
  });

  test("--json reports the skipped cookies and the origin counts", async () => {
    await seedUrl("https://example.com/");
    const c = fakeClient({
      evaluate: () => undefined,
      state: () => ({ url: "https://example.com/", title: "t" }),
    });
    const file = await writeStateFile({
      cookies: [cookie("a")],
      origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }],
    });
    const out = await cmdStateLoad({ ...ctx({ json: true }), connect: async () => c }, file);
    expect(JSON.parse(out)).toEqual({ ok: true, file, cookiesSkipped: 1, originsRestored: 1, originsSkipped: 0 });
  });

  test("requires a file argument", async () => {
    const c = fakeClient({});
    await expect(cmdStateLoad({ ...ctx(), connect: async () => c }, "")).rejects.toThrow(/usage: bowser state-load/);
  });

  test("errors clearly when the file is missing", async () => {
    const c = fakeClient({});
    await expect(cmdStateLoad({ ...ctx(), connect: async () => c }, join(tmp, "does-not-exist.json"))).rejects.toThrow(/file not found/);
  });
});

// F5: the file's shape is checked before any daemon request, with
// playwright-cli's wording, and a bad file is the user's error (exit 1).
describe("state-load checks the file's shape", () => {
  const cases: Array<[string, unknown, string]> = [
    ["origins is an object", { origins: {} }, "storageState.origins: expected array, got object"],
    ["the top level is null", null, "storageState: expected object, got null"],
    ["the top level is a string", "x", "storageState: expected object, got string"],
    ["cookies is a string", { cookies: "nope" }, "storageState.cookies: expected array, got string"],
    ["an origin is a number", { origins: [5] }, "storageState.origins[0]: expected object, got number"],
    ["an origin has no origin string", { origins: [{ localStorage: [] }] }, "storageState.origins[0].origin: expected string, got undefined"],
    ["localStorage is an object", { origins: [{ origin: "https://example.com", localStorage: {} }] }, "storageState.origins[0].localStorage: expected array, got object"],
    ["an entry has no value", { origins: [{ origin: "https://example.com", localStorage: [{ name: "n1" }] }] }, "storageState.origins[0].localStorage[0].value: expected string, got undefined"],
    ["an entry's value is a number", { origins: [{ origin: "https://example.com", localStorage: [{ name: "n2", value: 5 }] }] }, "storageState.origins[0].localStorage[0].value: expected string, got number"],
    ["an entry's name is null", { origins: [{ origin: "https://example.com", localStorage: [{ name: null, value: "v" }] }] }, "storageState.origins[0].localStorage[0].name: expected string, got null"],
    ["an entry is an array", { origins: [{ origin: "https://example.com", localStorage: [["k", "v"]] }] }, "storageState.origins[0].localStorage[0]: expected object, got array"],
  ];
  for (const [label, content, message] of cases) {
    test(`${label}: refused with the field, nothing sent to the daemon`, async () => {
      const file = tmpFile();
      await Bun.write(file, JSON.stringify(content));
      const c = fakeClient({ state: () => ({ url: "https://example.com/", title: "t" }) });
      const err = await cmdStateLoad({ ...ctx(), connect: async () => c }, file).catch((e) => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toBe(`state-load: ${message}`);
      expect(c.calls).toEqual([]);
    });
  }

  test("a top-level array is accepted, as playwright-cli does", async () => {
    const file = tmpFile();
    await Bun.write(file, "[]");
    const c = fakeClient({ state: () => ({ url: "https://example.com/", title: "t" }) });
    expect(await cmdStateLoad({ ...ctx(), connect: async () => c }, file)).toBe(`loaded ${file} (0 origin(s))`);
  });

  test("a missing file and invalid JSON are user errors too", async () => {
    const c = fakeClient({});
    const missing = await cmdStateLoad({ ...ctx(), connect: async () => c }, join(tmp, "nope.json")).catch((e) => e);
    expect(missing).toBeInstanceOf(UserError);
    const bad = tmpFile();
    await Bun.write(bad, "{not json");
    const invalid = await cmdStateLoad({ ...ctx(), connect: async () => c }, bad).catch((e) => e);
    expect(invalid).toBeInstanceOf(UserError);
    expect(invalid.message).toBe(`state-load: invalid JSON in ${bad}`);
  });
});
