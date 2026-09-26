// wrapView() against a fake view.
import { describe, expect, test } from "bun:test";
import { wrapView, type ViewLike } from "../src/browser.ts";
import { NAV_ARM, NAV_COUNT } from "../src/page-scripts.ts";

type Calls = Array<[string, unknown[]]>;

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
    /** A navigation lands: url changes, loading ends, onNavigated fires. */
    land(url) { v.url = url; v.loading = false; v.onNavigated?.(url, ""); },
    ...over,
  };
  return v;
}

describe("wrapView close", () => {
  test("with a persistent profile, close leaves the page first so its storage is written", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v, undefined, "/p").close();
    expect(v.calls).toEqual([["navigate", ["about:blank"]], ["close", []]]);
  });

  test("an ephemeral view just closes", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v).close();
    expect(v.calls).toEqual([["close", []]]);
  });
});

const fast = { graceMs: 40, settleMs: 300 };

/** The calls an action made, without the watch's own page reads. */
const own = (calls: Calls): Calls => calls.filter(([n, a]) => !(n === "evaluate" && (a[0] === NAV_ARM || a[0] === NAV_COUNT)));

/** A view whose page reports, as WebKit's Navigation API does, that a
 *  cross-document navigation began: `page.navs` is what NAV_COUNT reads.
 *  view.loading stays false, as it does on WebKit for a navigation the page
 *  starts (measured: a link click, a form submit, a script's location change). */
function pageNavView(over: Partial<ViewLike> = {}) {
  const page = { navs: 0 };
  const v = fakeView({
    evaluate: async (expr) => {
      v.calls.push(["evaluate", [expr]]);
      if (expr === NAV_ARM) { page.navs = 0; return undefined; }
      if (expr === NAV_COUNT) return page.navs;
      return undefined;
    },
    ...over,
  });
  return { v, page };
}

describe("wrapView navigation watch", () => {
  test("press goes through the watch like click", async () => {
    const v = fakeView();
    v.press = async (k) => { v.calls.push(["press", [k]]); setTimeout(() => v.land("https://x/submitted"), 10); };
    const b = wrapView(v, fast);
    await b.press("Enter");
    expect(b.url).toBe("https://x/submitted");
  });

  test("a failed navigation ends the wait without failing the action", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; setTimeout(() => { v.onNavigationFailed?.(new Error("-999")); }, 20); };
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.click("#l");
    expect(Date.now() - t0).toBeLessThan(fast.settleMs);
    expect(b.url).toBe("https://x/");
  });

  test("an action after a given-up navigation pays the grace window, not settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; };
    const b = wrapView(v, { graceMs: 20, settleMs: 60 });
    await b.click("#stuck");
    expect(v.loading).toBe(true);
    const t0 = Date.now();
    await b.click("#next");
    expect(Date.now() - t0).toBeLessThan(60);
  });

  test("click returns after a navigation that lands inside the grace window", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); setTimeout(() => v.land("https://x/two"), 10); };
    const b = wrapView(v, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/two");
  });

  test("click that navigates nowhere returns after the grace window", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.click("#btn");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(fast.graceMs - 5);
    expect(b.url).toBe("https://x/");
  });

  test("a navigation that starts inside the grace window is awaited past it", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; setTimeout(() => v.land("https://x/slow"), 120); };
    const b = wrapView(v, fast);
    await b.click("#l");
    expect(b.url).toBe("https://x/slow");
  });

  test("a navigation that never lands is given up after settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => { v.calls.push(["click", [s]]); v.loading = true; };
    const b = wrapView(v, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await b.click("#l");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(1000);
    expect(v.loading).toBe(true);
  });

  test("a navigation the page starts and the server is slow to answer is awaited until it lands", async () => {
    // F10: on WebKit neither view.loading nor onNavigated shows a
    // provisional navigation; only the page's navigate event does.
    const { v, page } = pageNavView();
    v.click = async (s) => { v.calls.push(["click", [s]]); page.navs++; setTimeout(() => v.land("https://x/slow"), 150); };
    const b = wrapView(v, fast);
    await b.click("#slow");
    expect(b.url).toBe("https://x/slow");
  });

  test("the page's signal is armed before the action, so an earlier navigation does not count", async () => {
    const { v, page } = pageNavView();
    page.navs = 1; // left over from a navigation that never landed
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.click("#btn");
    expect(Date.now() - t0).toBeLessThan(fast.graceMs + 40);
    expect(v.calls.map(([n, a]) => n === "evaluate" ? String(a[0]) : n)).toEqual([NAV_ARM, "click", NAV_COUNT]);
  });

  test("a page-started navigation that never lands is given up after settleMs", async () => {
    const { v, page } = pageNavView();
    v.click = async (s) => { v.calls.push(["click", [s]]); page.navs++; };
    const b = wrapView(v, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await b.click("#never");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(1000);
  });

  test("a navigation that replaces the one the action started is awaited, not ended by the first one's -999", async () => {
    const { v, page } = pageNavView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
      setTimeout(() => { page.navs++; v.onNavigationFailed?.(new Error("-999")); }, 80);
      setTimeout(() => v.land("https://x/second"), 160);
    };
    const b = wrapView(v, fast);
    await b.click("#twice");
    expect(b.url).toBe("https://x/second");
  });

  test("a failure with no navigation after it still ends the wait", async () => {
    // A 204 answer: the page's navigate event, then only a failure.
    const { v, page } = pageNavView();
    v.click = async (s) => { v.calls.push(["click", [s]]); page.navs++; setTimeout(() => v.onNavigationFailed?.(new Error("interrupted")), 60); };
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.click("#nocontent");
    expect(Date.now() - t0).toBeLessThan(fast.settleMs);
  });

  test("a page that cannot answer the read costs the grace window, not a failure", async () => {
    const v = fakeView({ evaluate: async () => { throw new Error("no longer reachable"); } });
    const b = wrapView(v, fast);
    await b.click("#btn");
    expect(b.url).toBe("https://x/");
  });

  test("back and forward use goBack/goForward when the runtime has them", async () => {
    const v = fakeView({
      goBack: async () => { v.calls.push(["goBack", []]); },
      goForward: async () => { v.calls.push(["goForward", []]); },
    });
    const b = wrapView(v, fast);
    await b.back();
    await b.forward();
    expect(own(v.calls)).toEqual([["goBack", []], ["goForward", []]]);
  });

  test("back, forward and reload fall back to history/location when the runtime lacks them", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.back();
    await b.forward();
    await b.reload();
    expect(own(v.calls)).toEqual([
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
    const b = wrapView(v, fast);
    await b.reload();
    expect(own(v.calls)).toEqual([["reload", []]]);
    expect(b.url).toBe("https://x/re");
  });
});

describe("wrapView interrupt", () => {
  test("reloads the page with the native call alone, and waits for it to land", async () => {
    // Measured on WebKit: a pending evaluate() makes a second one throw
    // ERR_INVALID_STATE, so the interrupt must not evaluate anything.
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); setTimeout(() => v.land("https://x/"), 30); } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.interrupt();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(v.calls).toEqual([["reload", []]]);
  });

  test("a stuck navigation the reload cancels ends the wait", async () => {
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); v.onNavigationFailed?.(new Error("-999")); } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.interrupt();
    expect(Date.now() - t0).toBeLessThan(30);
  });

  test("gives up after settleMs when nothing lands, as on a page stuck in a script", async () => {
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); } });
    const b = wrapView(v, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await b.interrupt();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  test("without a native reload it does nothing", async () => {
    const v = fakeView();
    await wrapView(v, fast).interrupt();
    expect(v.calls).toEqual([]);
  });
});

describe("wrapView watchNavigation", () => {
  test("a landing reports a navigation, with no page call", async () => {
    const v = fakeView();
    const b = wrapView(v);
    let navigated = 0;
    b.watchNavigation(() => { navigated++; });
    await b.navigate("https://x/1");
    v.land("https://x/1");
    expect(navigated).toBe(1);
    expect(v.calls).toEqual([["navigate", ["https://x/1"]]]);
  });

  test("an action whose navigation starts reports it before the navigation lands", async () => {
    const v = fakeView();
    const seen: string[] = [];
    v.click = async () => { v.loading = true; setTimeout(() => { seen.push("landed"); v.land("https://x/2"); }, 60); };
    const b = wrapView(v, { graceMs: 40, settleMs: 300 });
    b.watchNavigation(() => seen.push("navigation"));
    await b.click("a");
    expect(seen).toEqual(["navigation", "landed", "navigation"]);
  });
});
