// createHandler() against a fake Browser: every op reaches the right Browser
// method with the right arguments, errors come back as { ok: false }, and
// the cookie ops forward straight to the Browser's cookie methods (the CDP
// method selection they used to do inline now lives in Browser; see
// tests/browser.test.ts for that).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "../src/browser.ts";
import { CDP_UNAVAILABLE } from "../src/browser.ts";
import { createHandler } from "../src/daemon/server.ts";
import type { DaemonRequest } from "../src/daemon/protocol.ts";
import type { Cookie } from "../src/cdp/types.ts";

// A fully-populated CDP cookie (Cookie has more required fields than the
// name/value pair these tests care about; mirrors tests/state-storage.test.ts's
// cdpCookie helper).
const cookie: Cookie = {
  name: "a",
  value: "1",
  domain: "x",
  path: "/",
  expires: -1,
  size: 1,
  httpOnly: false,
  secure: false,
  session: true,
};

function fakeBrowser(over: Partial<Browser> = {}): Browser & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const rec = <T>(name: string, ret: T) => async (...a: unknown[]) => { calls.push([name, a]); return ret; };
  const b: Browser & { calls: typeof calls } = {
    calls,
    url: "https://x/", title: "X",
    realUrl: rec("realUrl", "https://x/"),
    realTitle: rec("realTitle", "X"),
    navigate: rec("navigate", undefined),
    evaluate: rec("evaluate", 42),
    click: rec("click", undefined),
    type: rec("type", undefined),
    press: rec("press", undefined),
    hover: rec("hover", undefined),
    select: rec("select", undefined),
    setChecked: rec("setChecked", undefined),
    screenshot: rec("screenshot", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")),
    resize: rec("resize", undefined),
    back: rec("back", undefined),
    forward: rec("forward", undefined),
    reload: rec("reload", undefined),
    close: rec("close", undefined),
    cdpAvailable: () => true,
    cdp: rec("cdp", { cookies: [{ name: "a", value: "1" }], success: true }),
    getCookies: rec("getCookies", [cookie]),
    setCookie: rec("setCookie", { success: true }),
    deleteCookies: rec("deleteCookies", undefined),
    clearCookies: rec("clearCookies", undefined),
    ...over,
  };
  return b;
}

const req = (op: DaemonRequest["op"], args?: unknown[]): DaemonRequest => ({ id: 7, op, args });

describe("createHandler", () => {
  test("ping answers pong without touching the browser", async () => {
    const b = fakeBrowser();
    expect(await createHandler(b)(req("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
    expect(b.calls).toEqual([]);
  });

  test("state returns the resolved url and title", async () => {
    const b = fakeBrowser();
    expect(await createHandler(b)(req("state"))).toEqual({ id: 7, ok: true, result: { url: "https://x/", title: "X" } });
  });

  test("navigate, select and resize forward their arguments", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("navigate", ["https://y/"]));
    await h(req("select", ["#s", "blue"]));
    await h(req("resize", [900, 700]));
    expect(b.calls).toEqual([["navigate", ["https://y/"]], ["select", ["#s", "blue"]], ["resize", [900, 700]]]);
  });

  test("check and uncheck map to setChecked", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("check", ["#c"]));
    await h(req("uncheck", ["#c"]));
    expect(b.calls).toEqual([["setChecked", ["#c", true]], ["setChecked", ["#c", false]]]);
  });

  test("screenshot with a path writes the file and returns { path }", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bowser-handler-"));
    try {
      const path = join(dir, "shot.png");
      const res = await createHandler(fakeBrowser())(req("screenshot", [path]));
      expect(res).toEqual({ id: 7, ok: true, result: { path } });
      expect(new Uint8Array(await readFile(path)).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cookie ops forward to the Browser's cookie methods", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    expect(await h(req("cookie-get-all", [["https://x/"]]))).toEqual({ id: 7, ok: true, result: [cookie] });
    await h(req("cookie-set", [{ name: "a", value: "1" }]));
    await h(req("cookie-delete", ["sid", { domain: "x" }]));
    await h(req("cookie-clear"));
    expect(b.calls).toEqual([
      ["getCookies", [["https://x/"]]],
      ["setCookie", [{ name: "a", value: "1" }]],
      ["deleteCookies", ["sid", { domain: "x" }]],
      ["clearCookies", []],
    ]);
  });

  test("a throwing browser method becomes { ok: false, error }", async () => {
    const b = fakeBrowser({ click: async () => { throw new Error("click: element not found"); } });
    expect(await createHandler(b)(req("click", ["#nope"]))).toEqual({ id: 7, ok: false, error: "click: element not found" });
  });

  test("an unknown op on the wire is rejected, not thrown", async () => {
    const res = await createHandler(fakeBrowser())({ id: 7, op: "dblclick" as DaemonRequest["op"], args: [] });
    expect(res).toEqual({ id: 7, ok: false, error: "unknown op: dblclick" });
  });

  test("a prototype key is an unknown op, not a lookup hit", async () => {
    const res = await createHandler(fakeBrowser())({ id: 7, op: "toString" as DaemonRequest["op"], args: [] });
    expect(res).toEqual({ id: 7, ok: false, error: "unknown op: toString" });
  });

  test("a cdp op on webkit is refused with the shared message before the handler runs", async () => {
    const b = fakeBrowser({ cdpAvailable: () => false });
    expect(await createHandler(b)(req("cookie-clear"))).toEqual({ id: 7, ok: false, error: CDP_UNAVAILABLE });
    expect(b.calls).toEqual([]);
  });

  test("a non-cdp op still runs when cdp is unavailable", async () => {
    const b = fakeBrowser({ cdpAvailable: () => false });
    expect(await createHandler(b)(req("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
  });
});
