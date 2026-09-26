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
    addEventListener: (event) => { calls.push(["addEventListener", [event]]); },
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

describe("wrapView close", () => {
  // A killed Chromium loses the cookies and localStorage it has not flushed
  // yet; only its own shutdown (CDP Browser.close) writes them to the profile.
  test("on chrome with a persistent profile, close shuts Chromium down through CDP first", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v, chrome, undefined, { profile: "/p", chromiumRunning: async () => false }).close();
    expect(v.calls).toEqual([["cdp", ["Browser.close", undefined]], ["close", []]]);
  });

  test("on webkit with a persistent profile, close leaves the page first so its storage is written", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v, webkit, undefined, { profile: "/p" }).close();
    expect(v.calls).toEqual([["navigate", ["about:blank"]], ["close", []]]);
  });

  test("close returns within the cap when the Chromium exit check never answers", async () => {
    // A stalled check (a hung `ps`) must not hold close past its cap: the
    // daemon's own close grace is 2 s and is spent next.
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    let aborted = false;
    const t0 = Date.now();
    await wrapView(v, chrome, undefined, {
      profile: "/p",
      exitCapMs: 100,
      chromiumRunning: (signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise<boolean>(() => {});
      },
    }).close();
    expect(Date.now() - t0).toBeLessThan(400);
    expect(aborted).toBe(true);
    expect(v.calls.at(-1)).toEqual(["close", []]);
  });

  test("close returns within the cap when Chromium never exits", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    let checks = 0;
    const t0 = Date.now();
    await wrapView(v, chrome, undefined, {
      profile: "/p", exitCapMs: 100, chromiumRunning: async () => { checks++; return true; },
    }).close();
    expect(Date.now() - t0).toBeLessThan(400);
    expect(checks).toBeGreaterThan(1);
    expect(v.calls.at(-1)).toEqual(["close", []]);
  });

  test("an ephemeral view just closes", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v, chrome).close();
    expect(v.calls).toEqual([["close", []]]);
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

describe("wrapView subscribe", () => {
  test("subscribe registers on chrome and reports it", () => {
    const seen: unknown[] = [];
    let registered: ((e: { type: string; data?: unknown }) => void) | null = null;
    const view = fakeView({ addEventListener: (_n, h) => { registered = h; } });
    const b = wrapView(view, chrome);
    expect(b.subscribe("Page.javascriptDialogOpening", (d) => seen.push(d))).toBe(true);
    registered!({ type: "Page.javascriptDialogOpening", data: { message: "sure?" } });
    expect(seen).toEqual([{ message: "sure?" }]);
  });

  test("subscribe refuses on webkit instead of registering a listener that never fires", () => {
    let calls = 0;
    const view = fakeView({ addEventListener: () => { calls++; } });
    const b = wrapView(view, webkit);
    expect(b.subscribe("Page.javascriptDialogOpening", () => {})).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("wrapView dialogs", () => {
  /** A chrome view that remembers its listeners, so a test can deliver a CDP event. */
  function listening() {
    const listeners = new Map<string, (e: { type: string; data?: unknown }) => void>();
    const v = fakeView({ addEventListener: (n, h) => { listeners.set(n, h); } });
    const emit = (type: string, data: unknown) => listeners.get(type)?.({ type, data });
    return { v, emit };
  }

  test("on chrome, CDP dialog events reach the listener as DialogState", () => {
    const { v, emit } = listening();
    const seen: unknown[] = [];
    const b = wrapView(v, chrome);
    expect(b.watchDialogs({
      opened: (d) => seen.push(["opened", d]),
      closed: () => seen.push(["closed"]),
      navigated: () => seen.push(["navigated"]),
    })).toBe(true);
    emit("Page.javascriptDialogOpening", { url: "u", frameId: "f", message: "name?", type: "prompt", hasBrowserHandler: false, defaultPrompt: "def" });
    emit("Page.javascriptDialogOpening", { url: "u", frameId: "f", message: "sure?", type: "confirm", hasBrowserHandler: false, defaultPrompt: "" });
    emit("Page.javascriptDialogClosed", { result: true, userInput: "" });
    v.land("https://x/next");
    expect(seen).toEqual([
      ["opened", { type: "prompt", message: "name?", defaultValue: "def" }],
      ["opened", { type: "confirm", message: "sure?" }],
      ["closed"],
      ["navigated"],
    ]);
  });

  test("on chrome the Page domain is enabled once, after the first navigation (CDP has no session before it)", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome);
    b.watchDialogs({ opened() {}, closed() {}, navigated() {} });
    expect(v.calls.filter(([n]) => n === "cdp")).toEqual([]);
    await b.navigate("https://x/1");
    await b.navigate("https://x/2");
    expect(v.calls.filter(([n]) => n === "cdp")).toEqual([["cdp", ["Page.enable", {}]]]);
  });

  test("answerDialog sends Page.handleJavaScriptDialog, with prompt text only when given", async () => {
    const v = fakeView();
    const b = wrapView(v, chrome);
    await b.answerDialog(true, "typed");
    await b.answerDialog(false);
    expect(v.calls).toEqual([
      ["cdp", ["Page.handleJavaScriptDialog", { accept: true, promptText: "typed" }]],
      ["cdp", ["Page.handleJavaScriptDialog", { accept: false }]],
    ]);
  });

  test("on chrome pageInfo asks the browser for our target's url and title (no evaluate)", async () => {
    const v = fakeView({ cdp: async (m, p) => { v.calls.push(["cdp", [m, p]]); return { targetInfo: { url: "https://x/?q=1", title: "Q", type: "page" } }; } });
    expect(await wrapView(v, chrome).pageInfo()).toEqual({ url: "https://x/?q=1", title: "Q" });
    expect(v.calls).toEqual([["cdp", ["Target.getTargetInfo", {}]]]);
  });

  test("on webkit no dialog events exist: watchDialogs says so, subscribes to nothing, still reports navigations", async () => {
    const v = fakeView();
    const b = wrapView(v, webkit);
    let navigated = 0;
    expect(b.watchDialogs({ opened() {}, closed() {}, navigated: () => { navigated++; } })).toBe(false);
    await b.navigate("https://x/1");
    v.land("https://x/1");
    expect(navigated).toBe(1);
    expect(v.calls).toEqual([["navigate", ["https://x/1"]]]);
  });
});
