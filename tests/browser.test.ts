// wrapView() against a fake view: the cookie methods pick the CDP call the
// old daemon switch picked, and every CDP path on webkit fails with the one
// shared message before touching the view.
import { describe, expect, test } from "bun:test";
import { CDP_UNAVAILABLE, wrapView, type ViewLike } from "../src/browser.ts";
import type { Cookie } from "../src/cdp/types.ts";

type Calls = Array<[string, unknown[]]>;

// A fully-populated CDP cookie (Cookie has more required fields than the
// name/value pair the test cares about; see tests/state-storage.test.ts's
// cdpCookie for the same pattern).
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

function fakeView(): ViewLike & { calls: Calls } {
  const calls: Calls = [];
  return {
    calls,
    url: "https://x/",
    title: "X",
    navigate: async (url) => { calls.push(["navigate", [url]]); },
    evaluate: async (expr) => { calls.push(["evaluate", [expr]]); return undefined; },
    click: async (s) => { calls.push(["click", [s]]); },
    type: async (t) => { calls.push(["type", [t]]); },
    press: async (k) => { calls.push(["press", [k]]); },
    resize: async (w, h) => { calls.push(["resize", [w, h]]); },
    cdp: async (m, p) => { calls.push(["cdp", [m, p]]); return { cookies: [cookie], success: true }; },
  };
}

const chrome = { kind: "chrome" as const };
const webkit = { kind: "webkit" as const };

describe("wrapView cookies", () => {
  test("getCookies scopes to Network.getCookies only when urls are given", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome);
    expect(await b.getCookies(["https://x/"])).toEqual([cookie]);
    await b.getCookies();
    await b.getCookies([]);
    expect(v.calls).toEqual([
      ["cdp", ["Network.getCookies", { urls: ["https://x/"] }]],
      ["cdp", ["Network.getAllCookies", undefined]],
      ["cdp", ["Network.getAllCookies", undefined]],
    ]);
  });

  test("setCookie returns the success flag", async () => {
    const v = fakeView();
    expect(await wrapView(v, chrome).setCookie({ name: "a", value: "1" })).toEqual({ success: true });
    expect(v.calls).toEqual([["cdp", ["Network.setCookie", { name: "a", value: "1" }]]]);
  });

  test("deleteCookies forwards only the options that were set", async () => {
    const v = fakeView();
    await wrapView(v, chrome).deleteCookies("sid", { domain: "x" });
    expect(v.calls).toEqual([["cdp", ["Network.deleteCookies", { name: "sid", domain: "x" }]]]);
  });

  test("deleteCookies treats null options like an empty object", async () => {
    const v = fakeView();
    await wrapView(v, chrome).deleteCookies("sid", null as never);
    expect(v.calls).toEqual([["cdp", ["Network.deleteCookies", { name: "sid" }]]]);
  });

  test("clearCookies calls Network.clearBrowserCookies", async () => {
    const v = fakeView();
    await wrapView(v, chrome).clearCookies();
    expect(v.calls).toEqual([["cdp", ["Network.clearBrowserCookies", undefined]]]);
  });

  test("on webkit every cookie method rejects with CDP_UNAVAILABLE and never reaches the view", async () => {
    const v = fakeView();
    const b = wrapView(v, webkit);
    expect(b.cdpAvailable()).toBe(false);
    await expect(b.getCookies()).rejects.toThrow(CDP_UNAVAILABLE);
    await expect(b.clearCookies()).rejects.toThrow(CDP_UNAVAILABLE);
    await expect(b.cdp("Network.enable")).rejects.toThrow(CDP_UNAVAILABLE);
    expect(v.calls).toEqual([]);
  });
});
