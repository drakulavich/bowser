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

type Fake = ViewLike & { calls: Calls; loading: boolean; url: string; land(url: string): void };

function fakeView(over: Partial<ViewLike> = {}): Fake {
  const calls: Calls = [];
  const v: Fake = {
    calls,
    url: "https://x/",
    title: "X",
    loading: false,
    onNavigated: null,
    onNavigationFailed: null,
    navigate: async (url) => { calls.push(["navigate", [url]]); v.url = url; },
    evaluate: async (expr) => { calls.push(["evaluate", [expr]]); return undefined; },
    click: async (s) => { calls.push(["click", [s]]); },
    type: async (t) => { calls.push(["type", [t]]); },
    press: async (k) => { calls.push(["press", [k]]); },
    resize: async (w, h) => { calls.push(["resize", [w, h]]); },
    cdp: async (m, p) => { calls.push(["cdp", [m, p]]); return { cookies: [cookie], success: true }; },
    /** A navigation lands: url changes, loading ends, onNavigated fires. */
    land(url) { v.url = url; v.loading = false; v.onNavigated?.(url, ""); },
    ...over,
  };
  return v;
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

  test("getCookies treats a null url list from the wire like none", async () => {
    const v = fakeView();
    await wrapView(v, chrome).getCookies(null as never);
    expect(v.calls).toEqual([["cdp", ["Network.getAllCookies", undefined]]]);
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

const fast = { graceMs: 40, settleMs: 300 };

describe("wrapView navigation watch", () => {
  test("press goes through the watch like click", async () => {
    const v = fakeView();
    v.press = async (k) => { v.calls.push(["press", [k]]); setTimeout(() => v.land("https://x/submitted"), 10); };
    const b = wrapView(v, chrome, fast);
    await b.press("Enter");
    expect(b.url).toBe("https://x/submitted");
  });

  test("a failed navigation ends the wait without failing the action", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; setTimeout(() => { v.onNavigationFailed?.(new Error("-999")); }, 20); };
    const b = wrapView(v, chrome, fast);
    const t0 = Date.now();
    await b.click("#l");
    expect(Date.now() - t0).toBeLessThan(fast.settleMs);
    expect(b.url).toBe("https://x/");
  });

  test("an action after a given-up navigation pays the grace window, not settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; };
    const b = wrapView(v, chrome, { graceMs: 20, settleMs: 60 });
    await b.click("#stuck");
    expect(v.loading).toBe(true);
    const t0 = Date.now();
    await b.click("#next");
    expect(Date.now() - t0).toBeLessThan(60);
  });

  test("click returns after a navigation that lands inside the grace window", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); setTimeout(() => v.land("https://x/two"), 10); };
    const b = wrapView(v, chrome, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/two");
  });

  test("click that navigates nowhere returns after the grace window", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome, fast);
    const t0 = Date.now();
    await b.click("#btn");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(fast.graceMs - 5);
    expect(b.url).toBe("https://x/");
  });

  test("a navigation that starts inside the grace window is awaited past it", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; setTimeout(() => v.land("https://x/slow"), 120); };
    const b = wrapView(v, chrome, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/slow");
  });

  test("a navigation that never lands is given up after settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; };
    const b = wrapView(v, chrome, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await b.click("#l");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(1000);
    expect(v.loading).toBe(true);
  });

  test("back and forward use goBack/goForward when the runtime has them", async () => {
    const v = fakeView({
      goBack: async () => { v.calls.push(["goBack", []]); },
      goForward: async () => { v.calls.push(["goForward", []]); },
    });
    const b = wrapView(v, chrome, fast);
    await b.back();
    await b.forward();
    expect(v.calls).toEqual([["goBack", []], ["goForward", []]]);
  });

  test("back, forward and reload fall back to history/location when the runtime lacks them", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome, fast);
    await b.back();
    await b.forward();
    await b.reload();
    expect(v.calls).toEqual([
      ["evaluate", ["history.back()"]],
      ["evaluate", ["history.forward()"]],
      ["evaluate", ["location.reload()"]],
    ]);
  });

  test("reload prefers the native call and waits for its navigation to land", async () => {
    // Native reload() resolves before the reload commits (measured), so the
    // fake resolves at once with loading=true and lands 60 ms later.
    const v = fakeView({ reload: async () => {
      v.calls.push(["reload", []]); v.loading = true;
      setTimeout(() => v.land("https://x/re"), 60);
    } });
    const b = wrapView(v, chrome, fast);
    await b.reload();
    expect(v.calls).toEqual([["reload", []]]);
    expect(b.url).toBe("https://x/re");
  });
});
