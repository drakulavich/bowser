// wrapView() against a fake view.
import { describe, expect, test } from "bun:test";
import { wrapView, type ViewLike } from "../src/browser.ts";
import { ACTS, createHandler } from "../src/daemon/server.ts";
import type { Op } from "../src/daemon/protocol.ts";
import { CANCEL_PENDING_NAVIGATION, KEY_WATCH, keyCommandScript, LEAVE_INITIAL_DOCUMENT, NAV_ARM, NAV_COUNT, NAV_DESTINATION } from "../src/page-scripts.ts";

type Calls = Array<[string, unknown[]]>;

/** WebKit's text for a navigation it cancelled. */
const CANCELLED = "The operation couldn’t be completed. (NSURLErrorDomain error -999.)";

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
    press: async (k, o) => { calls.push(["press", o ? [k, o] : [k]]); },
    resize: async (w, h) => { calls.push(["resize", [w, h]]); },
    goBack: async () => { calls.push(["goBack", []]); },
    goForward: async () => { calls.push(["goForward", []]); },
    /** A navigation lands: url changes, loading ends, onNavigated fires. */
    land(url) { v.url = url; v.loading = false; v.onNavigated?.(url, ""); },
    ...over,
  };
  return v;
}

describe("wrapView click", () => {
  test("passes its timeout to the view's selector click (#112)", async () => {
    const v = fakeView();
    const seen: unknown[] = [];
    v.click = async (s, o) => { seen.push([s, o]); };
    await wrapView(v).click("#a", 1234);
    expect(seen).toEqual([["#a", { timeout: 1234 }]]);
  });
});

describe("wrapView close", () => {
  test("with a persistent profile, close leaves the page first so its storage is written", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v, undefined, "/p", 0).close();
    expect(v.calls).toEqual([["navigate", ["about:blank"]], ["close", []]]);
  });

  // #61: WebKit commits localStorage 500 ms after a write, and Bun kills the
  // browser at exit, so a write made just before close was lost unless close
  // outlasted that window after the page was left.
  test("with a persistent profile, close waits out the storage commit window after leaving the page", async () => {
    let left = 0;
    let closed = 0;
    const v = fakeView({ navigate: async () => { left = Date.now(); } });
    v.close = () => { closed = Date.now(); };
    await wrapView(v, undefined, "/p", 150).close();
    expect(closed - left).toBeGreaterThanOrEqual(150);
  });

  test("an ephemeral view just closes", async () => {
    const v = fakeView();
    v.close = () => { v.calls.push(["close", []]); };
    await wrapView(v).close();
    expect(v.calls).toEqual([["close", []]]);
  });
});

// #63, oven-sh/bun#44134: a reply frame over 8 KB (a navigation to a long URL,
// an evaluate with a long result) sometimes reaches Bun only when the browser
// host gets its next message. The fakes model that: `host.stall(done)` holds a
// reply until the next message, and every call on a view is a message.
describe("wrapView stalled replies (oven-sh/bun#44134)", () => {
  function fakeHost() {
    let held: Array<() => void> = [];
    return {
      messages: 0,
      /** A message reaches the host: it writes out what it held. */
      message() { this.messages++; const h = held; held = []; for (const f of h) f(); },
      /** The host holds this reply until the next message. */
      stall(done: () => void) { held.push(done); },
    };
  }
  type Host = ReturnType<typeof fakeHost>;
  /** A kicker whose calls are messages. `stuck` holds its own reply to that
   *  call behind the next message, as a reply queued after a stalled one is. */
  function fakeKicker(host: Host, stuck: { evaluate?: boolean } = {}) {
    const calls: string[] = [];
    let closed = false;
    const k = {
      calls,
      get closed() { return closed; },
      evaluate: (expr: string) => new Promise<unknown>((r) => {
        calls.push("evaluate"); host.message();
        if (stuck.evaluate) host.stall(() => r(expr)); else r(expr);
      }),
      resize: (w: number, h: number) => new Promise<void>((r) => { calls.push(`resize ${w}x${h}`); host.message(); r(); }),
      close: () => { closed = true; },
    };
    return k;
  }
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p.then(() => "settled", () => "rejected"), Bun.sleep(ms).then(() => "pending")]);
  /** How wrapView gets the kicker: opened on demand, counted. */
  function lazy(k: ReturnType<typeof fakeKicker>, afterMs = 150) {
    const stalls = { opens: 0, afterMs, open: () => { stalls.opens++; return k; } };
    return stalls;
  }

  test("a navigate whose reply stalls settles", async () => {
    const host = fakeHost();
    const v = fakeView({ navigate: (url) => new Promise<void>((r) => { host.message(); host.stall(() => { v.land(url); r(); }); }) });
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)));
    expect(await within(b.navigate("data:text/html,long"), 1000)).toBe("settled");
    expect(b.url).toBe("data:text/html,long");
  });

  test("its failure still reaches the caller", async () => {
    const host = fakeHost();
    const v = fakeView({ navigate: () => new Promise<void>((_, no) => { host.message(); host.stall(() => no(new Error("nav failed"))); }) });
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)));
    expect(await within(b.navigate("data:text/html,long"), 1000)).toBe("rejected");
  });

  // The residual of a navigate-only kick: `state` reads location.href, which
  // is the long URL again (1 in 600 gotos under load).
  test("an evaluate whose reply stalls settles, with its result", async () => {
    const host = fakeHost();
    const v = fakeView({ evaluate: (expr) => new Promise((r) => { host.message(); host.stall(() => r(`long ${expr}`)); }) });
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)));
    expect(await within(b.realUrl(), 1000)).toBe("settled");
    expect(await b.evaluate("x")).toBe("long x");
  });

  test("a navigation an action started lands although its event stalls", async () => {
    const host = fakeHost();
    const v = fakeView({ click: async () => { host.message(); v.loading = true; host.stall(() => v.land("https://x/next")); } });
    const b = wrapView(v, { graceMs: 40, settleMs: 5000 }, undefined, 0, lazy(fakeKicker(host)));
    const t0 = Date.now();
    await b.click("a");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(b.url).toBe("https://x/next");
  });

  test("a kick whose own reply stalls does not stop the kicking", async () => {
    // The reply needs two more messages: each one flushes part of it.
    const host = fakeHost();
    const v = fakeView({
      navigate: () => new Promise<void>((r) => { host.message(); host.stall(() => host.stall(r)); }),
    });
    const k = fakeKicker(host, { evaluate: true });
    const b = wrapView(v, fast, undefined, 0, lazy(k));
    expect(await within(b.navigate("data:text/html,long"), 1000)).toBe("settled");
    expect(k.calls).toContain("resize 1x1");
  });

  test("kicks only while a call is pending, and close closes the kicker", async () => {
    const host = fakeHost();
    const k = fakeKicker(host);
    const b = wrapView(fakeView({ navigate: () => Bun.sleep(400) }), fast, undefined, 0, lazy(k));
    await b.navigate("https://slow/");
    const kicks = k.calls.length;
    expect(kicks).toBeGreaterThan(0);
    await Bun.sleep(250);
    expect(k.calls.length).toBe(kicks);
    await b.close();
    expect(k.closed).toBe(true);
  });

  // The owner's call: a session that never meets the bug does not pay for
  // the second view (a WebContent process, ~25 MB).
  test("calls that answer within afterMs open no kicker", async () => {
    const host = fakeHost();
    const stalls = lazy(fakeKicker(host));
    const v = fakeView({ navigate: async (url) => { await Bun.sleep(50); v.land(url); } });
    const b = wrapView(v, fast, undefined, 0, stalls);
    await b.navigate("https://x/a");
    await b.evaluate("1");
    await b.click("a");
    await b.screenshot().catch(() => {});
    await Bun.sleep(300);
    await b.close();
    expect(stalls.opens).toBe(0);
    expect(b.kickerOpened).toBe(false);
  });

  test("a stalled call opens the kicker after afterMs, and the session keeps it", async () => {
    const host = fakeHost();
    const k = fakeKicker(host);
    const stalls = lazy(k, 300);
    const v = fakeView({ navigate: (url) => new Promise<void>((r) => { host.message(); host.stall(() => { v.land(url); r(); }); }) });
    const b = wrapView(v, fast, undefined, 0, stalls);
    const first = b.navigate("data:text/html,long-1");
    await Bun.sleep(200);
    expect(stalls.opens).toBe(0);
    expect(await within(first, 1000)).toBe("settled");
    expect(b.kickerOpened).toBe(true);
    expect(await within(b.navigate("data:text/html,long-2"), 1000)).toBe("settled");
    expect(stalls.opens).toBe(1);
    expect(k.closed).toBe(false);
    await b.close();
    expect(k.closed).toBe(true);
  });
});

const fast = { graceMs: 40, settleMs: 300 };
// For "at once" checks: any wait for a landing costs at least graceMs.
const slow = { graceMs: 1_000, settleMs: 2_000 };

/** The calls an action made, without the watch's own page reads. */
const own = (calls: Calls): Calls => calls.filter(([n, a]) => !(n === "evaluate" && (a[0] === NAV_ARM || a[0] === NAV_COUNT)));

/** A view whose page reports, as WebKit's Navigation API does, that a
 *  cross-document navigation began: `page.navs` is what NAV_COUNT reads.
 *  view.loading stays false, as it does on WebKit for a navigation the page
 *  starts (measured: a link click, a form submit, a script's location change). */
function pageNavView(over: Partial<ViewLike> = {}) {
  const page: { navs: number; to?: string } = { navs: 0 };
  const v = fakeView({
    evaluate: async (expr) => {
      v.calls.push(["evaluate", [expr]]);
      if (expr === NAV_ARM) { page.navs = 0; return undefined; }
      if (expr === NAV_COUNT) return page.navs;
      if (expr === NAV_DESTINATION) return page.to;
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

  test("press Tab sends the tab character, which WebKit takes as a key event that moves focus (F11)", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.press("Tab");
    await b.press("Enter");
    await b.press("t");
    expect(v.calls.filter(([op]) => op === "press")).toEqual([["press", ["\t"]], ["press", ["Enter"]], ["press", ["t"]]]);
  });

  // #55: WebKit gets a modifier with the key, and Tab stays the tab character.
  test("press with modifiers passes them to the view", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.press("Tab", ["Shift"]);
    await b.press("ArrowLeft", ["Meta"]);
    expect(v.calls.filter(([op]) => op === "press")).toEqual([
      ["press", ["\t", { modifiers: ["Shift"] }]],
      ["press", ["ArrowLeft", { modifiers: ["Meta"] }]],
    ]);
  });

  // #55: Bun.WebView sends Meta+A/Z as key events only; macOS runs them as
  // menu commands, which WebKit never sees. bowser runs the command itself,
  // unless the page cancelled the keydown (measured on WebKit, Bun 1.4.2).
  for (const [key, mods, command] of [
    ["a", ["Meta"], "selectAll"],
    ["A", ["Meta"], "selectAll"],
    ["z", ["Meta"], "undo"],
    ["z", ["Shift", "Meta"], "redo"],
  ] as const) {
    test(`${mods.join("+")}+${key} runs ${command} after the key, when the page let the keydown through`, async () => {
      const v = fakeView();
      const b = wrapView(v, fast);
      await b.press(key, [...mods]);
      const seen = v.calls.filter(([op, args]) => op === "press" || (op === "evaluate" && args[0] !== NAV_ARM && args[0] !== NAV_COUNT));
      expect(seen).toEqual([
        ["evaluate", [KEY_WATCH]],
        ["press", [key, { modifiers: [...mods] }]],
        ["evaluate", [keyCommandScript(command)]],
      ]);
    });
  }

  test("other combinations run no command: Control+a, Shift+Meta+a, Meta+c", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.press("a", ["Control"]);
    await b.press("a", ["Shift", "Meta"]);
    await b.press("c", ["Meta"]);
    expect(v.calls.filter(([op, args]) => op === "evaluate" && args[0] !== NAV_ARM && args[0] !== NAV_COUNT)).toEqual([]);
  });

  test("press Tab still goes through the watch", async () => {
    const v = fakeView();
    v.press = async (k) => { v.calls.push(["press", [k]]); setTimeout(() => v.land("https://x/next"), 10); };
    const b = wrapView(v, fast);
    await b.press("Tab");
    expect(b.url).toBe("https://x/next");
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

  test("a reread that never answers still leaves the wait at settleMs", async () => {
    // Codex's repro: the NAV_COUNT reread after a failure stays pending, and
    // an unbounded await never looked at the deadline again.
    let reads = 0;
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        if (expr === NAV_ARM) { page.navs = 0; return undefined; }
        if (expr === NAV_COUNT && ++reads > 1) return new Promise(() => {});
        return page.navs;
      },
    });
    v.click = async () => { page.navs++; setTimeout(() => v.onNavigationFailed?.(new Error("-999")), 40); };
    const b = wrapView(v, { graceMs: 20, settleMs: 60 });
    const t0 = Date.now();
    await Promise.race([b.click("#x"), Bun.sleep(400)]);
    const elapsed = Date.now() - t0;
    expect(reads).toBe(2);
    expect(elapsed).toBeLessThan(20 + 60 + 60);
  });

  test("a read that act stops waiting for stays tracked: the next evaluate queues behind it instead of failing", async () => {
    // WebKit allows one evaluate per view; a second one while the first is
    // pending throws ERR_INVALID_STATE. On a slow machine the read at the
    // end of the grace window outlived its bound, and the next op's
    // evaluate failed (CI, PR #46).
    let pending = false;
    const log: string[] = [];
    const v = fakeView({
      evaluate: async (expr) => {
        if (pending) throw new Error("Invalid state: an evaluate() is already pending");
        log.push(`start ${expr === NAV_COUNT ? "count" : expr === NAV_ARM ? "arm" : expr}`);
        pending = true;
        try {
          if (expr === NAV_COUNT) { await Bun.sleep(300); return 0; }
          return expr === "1" ? 1 : undefined;
        } finally {
          pending = false;
          log.push(`end ${expr === NAV_COUNT ? "count" : expr === NAV_ARM ? "arm" : expr}`);
        }
      },
    });
    const b = wrapView(v, { graceMs: 100, settleMs: 1000 });
    const t0 = Date.now();
    await b.click("#btn");
    // act stopped waiting for the slow read at its 100 ms bound.
    expect(Date.now() - t0).toBeLessThan(290);
    expect(await b.evaluate("1")).toBe(1);
    expect(log).toEqual(["start arm", "end arm", "start count", "end count", "start 1", "end 1"]);
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

  test("back and forward call goBack/goForward, with no page fallback", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.back();
    await b.forward();
    expect(own(v.calls)).toEqual([["goBack", []], ["goForward", []]]);
  });

  test("reload falls back to location.reload() when the runtime lacks it", async () => {
    const v = fakeView({ evaluate: async (expr) => {
      v.calls.push(["evaluate", [expr]]);
      if (expr === "location.reload()") setTimeout(() => v.land("https://x/"), 10);
      return undefined;
    } });
    const b = wrapView(v, fast);
    await b.reload();
    expect(own(v.calls)).toEqual([["evaluate", ["location.reload()"]]]);
  });

  // #116: on WebKit a reload shows no sign before it lands: view.loading
  // stays false, the page sees no navigate event, and the server may take
  // longer than the grace window to answer.
  test("reload waits for its landing past the grace and settle windows, as navigate does", async () => {
    const v = fakeView({ reload: async () => { setTimeout(() => v.land("https://x/"), fast.settleMs + 100); } });
    const b = wrapView(v, fast);
    let during = "";
    setTimeout(() => { during = b.phase; }, fast.graceMs * 3);
    const t0 = Date.now();
    await b.reload();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(fast.settleMs + 90);
    expect(during).toBe("awaiting-navigation");
    expect(b.navigationPending).toBe(false);
  });

  test("reload of a view where nothing has committed does not wait for a landing", async () => {
    const v = fakeView({ reload: async () => {} });
    v.url = "";
    const b = wrapView(v, slow);
    const t0 = Date.now();
    await b.reload();
    expect(Date.now() - t0).toBeLessThan(slow.settleMs);
  });

  test("a reload that a page script cancels waits for the script's navigation", async () => {
    const { v, page } = pageNavView({ reload: async () => {
      setTimeout(() => { page.navs = 1; v.onNavigationFailed?.(new Error(CANCELLED)); }, 30);
      setTimeout(() => v.land("https://x/elsewhere"), 120);
    } });
    const b = wrapView(v, fast);
    await b.reload();
    expect(b.url).toBe("https://x/elsewhere");
  });

  test("reload ends at once when its own failure arrives before reload resolves", async () => {
    const v = fakeView({ reload: async () => { v.onNavigationFailed?.(new Error("Could not connect to the server.")); } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    expect(await Promise.race([b.reload().then(() => "returned"), Bun.sleep(fast.settleMs * 2).then(() => "waiting")])).toBe("returned");
    expect(Date.now() - t0).toBeLessThan(fast.settleMs);
  });

  test("reload waits when the cancelled navigation fails before reload resolves", async () => {
    const { v, page } = pageNavView({ reload: async () => {
      setTimeout(() => { page.navs = 1; v.onNavigationFailed?.(new Error(CANCELLED)); }, 10);
      await Bun.sleep(30);
      setTimeout(() => v.land("https://x/elsewhere"), 40);
    } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    await b.reload();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(b.url).toBe("https://x/elsewhere");
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

  test("phase is awaiting-navigation while act waits for a landing", async () => {
    const v = fakeView();
    let during = "";
    const b = wrapView(v, fast);
    v.click = async () => { during = b.phase; v.loading = true; setTimeout(() => v.land("https://x/next"), 100); };
    expect(b.phase).toBe("idle");
    const clicked = b.click("#go");
    await Bun.sleep(50);
    expect(during).toBe("acting");
    expect(b.phase).toBe("awaiting-navigation");
    await clicked;
    expect(b.phase).toBe("idle");
  });

  test("phase is delivered while the watch waits for a navigation that never begins", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    const clicked = b.click("#go");
    await Bun.sleep(fast.graceMs / 2);
    expect(b.phase).toBe("delivered");
    await clicked;
    expect(b.phase).toBe("idle");
  });

  test("phase turns awaiting-navigation when the page reports a navigation it started", async () => {
    const { v, page } = pageNavView({ click: async () => { page.navs = 1; } });
    const b = wrapView(v, fast);
    const clicked = b.click("#go");
    await Bun.sleep(fast.graceMs * 2);
    expect(b.phase).toBe("awaiting-navigation");
    v.land("https://x/next");
    await clicked;
    expect(b.phase).toBe("idle");
  });

  test("phase resets to idle when the action throws", async () => {
    const v = fakeView({ click: async () => { throw new Error("no element"); } });
    const b = wrapView(v, fast);
    await expect(b.click("#missing")).rejects.toThrow("no element");
    expect(b.phase).toBe("idle");
  });
});

// ET-10 (#78): a form POST to a server that never answers leaves a page
// navigation pending after `click` returns; a selector click started then
// hangs for good on WebKit, even once the page commits.
// #116, measured on WebKit: navigate() answers the first landing after it.
// When it cancels a navigation still loading (a reload's, a page script's),
// that one's -999 comes first and rejects it, and its own lands just after.
describe("navigate over a navigation still loading", () => {
  /** A view whose navigate cancels a pending navigation, then fires `then`. */
  function cancelling(then: (v: Fake, url: string) => void) {
    const v = fakeView({ navigate: async (url) => {
      v.onNavigationFailed?.(new Error(CANCELLED));
      setTimeout(() => then(v, url), 30);
      throw new Error(CANCELLED);
    } });
    return v;
  }

  test("waits for its own landing instead of failing with the cancelled one's -999", async () => {
    const b = wrapView(cancelling((v, url) => v.land(url)), fast);
    await b.navigate("https://x/next");
    expect(b.url).toBe("https://x/next");
  });

  test("its own failure is reported", async () => {
    const b = wrapView(cancelling((v) => v.onNavigationFailed?.(new Error("Could not connect to the server."))), fast);
    await expect(b.navigate("https://x/next")).rejects.toThrow("Could not connect to the server.");
  });

  test("cancelled itself, it fails with bowser's message, not WebKit's", async () => {
    const b = wrapView(cancelling((v) => v.onNavigationFailed?.(new Error(CANCELLED))), fast);
    const err = await b.navigate("https://x/next").then(() => undefined, (e: Error) => e);
    expect(err?.message).toBe("navigate: the navigation to https://x/next was cancelled by another navigation; run 'bowser snapshot' to see where the page is");
  });

  test("any other failure is reported at once", async () => {
    const v = fakeView({ navigate: async () => { throw new Error("bad URL"); } });
    await expect(wrapView(v, fast).navigate("nope")).rejects.toThrow("bad URL");
  });
});

describe("a navigation a previous command left pending", () => {
  const slow = { graceMs: 20, settleMs: 60 };
  /** A view whose `#send` starts a page navigation to `to` that nothing
   *  answers; with `to` null the page cannot say where it goes. */
  function submitted(to: string | null = "https://x/never") {
    const { v, page } = pageNavView();
    v.click = async (s) => { v.calls.push(["click", [s]]); if (s === "#send") { page.navs++; page.to = to ?? undefined; } };
    return v;
  }
  const stillLoading = (url: string) => `page is still loading ${url}; retry later, or run 'bowser close'`;
  const clicks = (v: Fake) => v.calls.filter(([n]) => n === "click").map(([, a]) => a[0]);

  test("is pending after act gives up on it, until a landing or a failure", async () => {
    for (const end of ["landed", "failed"] as const) {
      const v = submitted();
      const b = wrapView(v, slow);
      expect(b.navigationPending).toBe(false);
      await b.click("#send");
      expect(b.navigationPending).toBe(true);
      if (end === "landed") v.land("https://x/never");
      else { v.onNavigationFailed?.(new Error("Frame load interrupted")); await Bun.sleep(10); }
      expect(b.navigationPending).toBe(false);
    }
  });

  test("stays pending when a script replaces it after the watch ended, until the replacement lands (#98)", async () => {
    const { v, page } = pageNavView();
    v.click = async (s) => { v.calls.push(["click", [s]]); page.navs++; page.to = "https://x/never"; };
    const b = wrapView(v, slow);
    await b.click("#send");
    page.navs++;
    page.to = "https://x/never2";
    v.onNavigationFailed?.(new Error("-999"));
    await Bun.sleep(10);
    expect(b.navigationPending).toBe(true);
    v.land("https://x/never2");
    expect(b.navigationPending).toBe(false);
  });

  test("two failures read NAV_COUNT in order and do not leave a failed replacement pending", async () => {
    let countReads = 0;
    let startFirstFailureRead!: () => void;
    let releaseFirstFailureRead!: () => void;
    const firstFailureReadStarted = new Promise<void>((resolve) => { startFirstFailureRead = resolve; });
    const firstFailureReadGate = new Promise<void>((resolve) => { releaseFirstFailureRead = resolve; });
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        if (expr === NAV_ARM) { page.navs = 0; return undefined; }
        if (expr === NAV_COUNT && ++countReads === 2) {
          startFirstFailureRead();
          await firstFailureReadGate;
        }
        if (expr === NAV_COUNT) return page.navs;
        if (expr === NAV_DESTINATION) return page.to;
        return undefined;
      },
    });
    v.click = async () => { page.navs++; };
    const b = wrapView(v, slow);
    await b.click("#send");

    v.onNavigationFailed?.(new Error("-999"));
    await firstFailureReadStarted;
    page.navs++;
    v.onNavigationFailed?.(new Error("-999"));
    releaseFirstFailureRead();

    const settled = Date.now() + 200;
    while (b.navigationPending && Date.now() < settled) await Bun.sleep(1);
    expect(countReads).toBe(3);
    expect(b.navigationPending).toBe(false);
    expect(v.calls.filter(([name, args]) => name === "evaluate" && args[0] === NAV_COUNT)).toHaveLength(3);
  });

  test("an action that navigates nowhere leaves nothing pending", async () => {
    const v = submitted();
    const b = wrapView(v, slow);
    await b.click("#other");
    expect(b.navigationPending).toBe(false);
  });

  test("an action waits for a navigation a previous command left pending, then fails with 'page is still loading'", async () => {
    const v = submitted();
    const handle = createHandler(wrapView(v, slow));
    expect((await handle({ id: 1, op: "click", args: ["#send"] })).ok).toBe(true);
    const t0 = Date.now();
    const res = await handle({ id: 2, op: "click", args: ["#b"] }, t0 + 150);
    const elapsed = Date.now() - t0;
    expect(res).toEqual({ id: 2, ok: false, error: stillLoading("https://x/never") });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(400);
    expect(clicks(v)).toEqual(["#send"]);
  });

  test("a page that cannot say where its navigation goes is named by the view's url", async () => {
    const v = submitted(null);
    const handle = createHandler(wrapView(v, slow));
    await handle({ id: 1, op: "click", args: ["#send"] });
    const res = await handle({ id: 2, op: "click", args: ["#b"] }, Date.now() + 50);
    expect(res.error).toBe(stillLoading("https://x/"));
  });

  test("an action waits for a pending navigation that lands, then acts on the new page", async () => {
    const v = submitted();
    const handle = createHandler(wrapView(v, slow));
    await handle({ id: 1, op: "click", args: ["#send"] });
    setTimeout(() => v.land("https://x/answered"), 100);
    const res = await handle({ id: 2, op: "click", args: ["#b"] }, Date.now() + 2000);
    expect(res.ok).toBe(true);
    expect(clicks(v)).toEqual(["#send", "#b"]);
    expect(v.url).toBe("https://x/answered");
  });

  test("every ACTS op waits; evaluate and the navigating ops do not", async () => {
    for (const op of ACTS) {
      const v = submitted();
      const handle = createHandler(wrapView(v, slow));
      await handle({ id: 1, op: "click", args: ["#send"] });
      const res = await handle({ id: 2, op, args: ACT_ARGS[op] ?? [] }, Date.now() + 30);
      expect([op, res.error]).toEqual([op, stillLoading("https://x/never")]);
    }
    for (const op of ["evaluate", "reload", "back", "navigate"] as const) {
      const v = submitted();
      v.reload = async () => { setTimeout(() => v.land(v.url), 5); };
      const handle = createHandler(wrapView(v, slow));
      await handle({ id: 1, op: "click", args: ["#send"] });
      const res = await handle({ id: 2, op, args: op === "evaluate" ? ["1"] : op === "navigate" ? ["https://x/b"] : [] }, Date.now() + 30);
      expect([op, res.error]).toEqual([op, undefined]);
    }
  });
});

describe("wrapView interrupt", () => {
  test("reloads the page with the native call alone, and waits for it to land", async () => {
    // Measured on WebKit: a pending evaluate() makes a second one throw
    // ERR_INVALID_STATE, so the interrupt must not evaluate anything.
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); setTimeout(() => v.land("https://x/"), 30); } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    expect(await b.interrupt()).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(v.calls).toEqual([["reload", []]]);
  });

  test("counts a successful landing that happens before reload resolves", async () => {
    const v = fakeView({ reload: async () => { v.land("https://x/reloaded"); } });
    expect(await wrapView(v, fast).interrupt()).toBe(true);
  });

  test("a reload that never settles ends the interrupt at settleMs", async () => {
    const v = fakeView({ reload: () => new Promise<void>(() => {}) });
    const t0 = Date.now();
    expect(await wrapView(v, { graceMs: 20, settleMs: 60 }).interrupt()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("interrupt waits past the cancelled navigation's failure", async () => {
    const v = fakeView({ reload: async () => {
      v.onNavigationFailed?.(new Error("-999"));
      setTimeout(() => v.land("https://x/"), 100);
    } });
    const b = wrapView(v, fast);
    const t0 = Date.now();
    expect(await b.interrupt()).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);
  });

  test("interrupt returns false when nothing lands", async () => {
    const v = fakeView({ reload: async () => { v.calls.push(["reload", []]); } });
    const b = wrapView(v, { graceMs: 20, settleMs: 50 });
    const t0 = Date.now();
    expect(await b.interrupt()).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  test("interrupt returns false when only the failure lands", async () => {
    const v = fakeView({ reload: async () => { v.onNavigationFailed?.(new Error("-999")); } });
    const b = wrapView(v, { graceMs: 20, settleMs: 50 });
    expect(await b.interrupt()).toBe(false);
  });

  test("a second landing within settleMs frees the view too", async () => {
    const v = fakeView({ reload: async () => {
      v.onNavigationFailed?.(new Error("-999"));
      setTimeout(() => v.onNavigationFailed?.(new Error("-999")), 20);
    } });
    expect(await wrapView(v, fast).interrupt()).toBe(true);
  });

  // Measured on WebKit (#78, Task 1): while a selector click is hung on a
  // pending page navigation, reload() throws ERR_INVALID_STATE, and a script
  // location.replace frees the view (5 of 5).
  test("a refused reload falls back to a script that cancels the pending navigation", async () => {
    const v = fakeView({
      reload: async () => { v.calls.push(["reload", []]); throw new Error("ERR_INVALID_STATE: a navigation is already pending"); },
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        v.onNavigationFailed?.(new Error("-999"));
        setTimeout(() => v.land("https://x/"), 20);
        return "https://x/";
      },
    });
    expect(await wrapView(v, fast).interrupt()).toBe(true);
    expect(v.calls).toEqual([["reload", []], ["evaluate", [CANCEL_PENDING_NAVIGATION]]]);
  });

  test("the fallback script bypasses wrapView's evaluate queue", async () => {
    let first = true;
    const v = fakeView({
      reload: async () => { throw new Error("ERR_INVALID_STATE: a navigation is already pending"); },
      evaluate: (expr) => {
        v.calls.push(["evaluate", [expr]]);
        if (first) { first = false; return new Promise(() => {}); }
        setTimeout(() => v.land("https://x/"), 10);
        return Promise.resolve(1);
      },
    });
    const b = wrapView(v, fast);
    void b.evaluate("stuck");
    expect(await b.interrupt()).toBe(true);
    expect(v.calls.at(-1)).toEqual(["evaluate", [CANCEL_PENDING_NAVIGATION]]);
  });

  test("a fallback script that never answers ends the interrupt at settleMs", async () => {
    const v = fakeView({
      reload: async () => { throw new Error("ERR_INVALID_STATE: a navigation is already pending"); },
      evaluate: () => new Promise(() => {}),
    });
    const t0 = Date.now();
    expect(await wrapView(v, { graceMs: 20, settleMs: 60 }).interrupt()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("a refused reload and a refused script return false at once", async () => {
    const v = fakeView({
      reload: async () => { throw new Error("ERR_INVALID_STATE: a navigation is already pending"); },
      evaluate: async () => { throw new Error("Invalid state: an evaluate() is already pending"); },
    });
    const t0 = Date.now();
    expect(await wrapView(v, slow).interrupt()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(slow.graceMs);
  });

  // #48, measured on WebKit (Bun 1.4.2): before the first commit (url "")
  // reload() does nothing and navigate() is refused while one is pending;
  // the initial document still runs a script, and leaving it cancels the
  // stuck navigation (-999).
  test("before anything committed, the page leaves for about:blank instead of reloading", async () => {
    const v = fakeView({
      reload: async () => { v.calls.push(["reload", []]); },
      evaluate: async (expr) => { v.calls.push(["evaluate", [expr]]); v.onNavigationFailed?.(new Error("-999")); return 1; },
    });
    v.url = "";
    const b = wrapView(v, slow);
    const t0 = Date.now();
    expect(await b.interrupt()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(slow.graceMs);
    expect(v.calls).toEqual([["evaluate", [LEAVE_INITIAL_DOCUMENT]]]);
  });

  // #67, measured on a bare WebView (Bun 1.4.2): with an evaluate pending on
  // the initial document, WebKit refuses a second evaluate at once, reload()
  // does nothing, and navigate("about:blank") frees the stuck one (~3.2 s).
  test("before anything committed, an evaluate refused because one is pending falls back to navigating to about:blank", async () => {
    const v = fakeView({
      reload: async () => { v.calls.push(["reload", []]); },
      evaluate: async (expr) => { v.calls.push(["evaluate", [expr]]); throw new Error("Invalid state: an evaluate() is already pending"); },
    });
    v.url = "";
    const b = wrapView(v, slow);
    const t0 = Date.now();
    await b.interrupt();
    expect(Date.now() - t0).toBeLessThan(slow.graceMs);
    expect(v.calls).toEqual([["evaluate", [LEAVE_INITIAL_DOCUMENT]], ["navigate", ["about:blank"]]]);
  });

  test("a stuck initial-document evaluate and navigation are each bounded", async () => {
    const v = fakeView({
      evaluate: () => new Promise<unknown>(() => {}),
      navigate: () => new Promise<void>(() => {}),
    });
    v.url = "";
    const t0 = Date.now();
    expect(await wrapView(v, { graceMs: 20, settleMs: 60 }).interrupt()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("the about:blank fallback is awaited until it settles", async () => {
    let settled = 0;
    const v = fakeView({
      evaluate: async () => { throw new Error("Invalid state: an evaluate() is already pending"); },
      navigate: async () => { await Bun.sleep(40); settled = Date.now(); },
    });
    v.url = "";
    expect(await wrapView(v, { graceMs: 20, settleMs: 300 }).interrupt()).toBe(true);
    expect(settled).toBeGreaterThan(0);
  });

  test("an about:blank fallback that never settles ends the interrupt at settleMs", async () => {
    const v = fakeView({
      evaluate: async () => { throw new Error("Invalid state: an evaluate() is already pending"); },
      navigate: () => new Promise<void>(() => {}),
    });
    v.url = "";
    const t0 = Date.now();
    expect(await wrapView(v, { graceMs: 20, settleMs: 60 }).interrupt()).toBe(false);
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(55);
    expect(ms).toBeLessThan(200);
  });

  test("an about:blank fallback that is refused ends the interrupt", async () => {
    const v = fakeView({
      evaluate: async () => { throw new Error("Invalid state: an evaluate() is already pending"); },
      navigate: async () => { throw new Error("Invalid state: a navigation is already pending"); },
    });
    v.url = "";
    const t0 = Date.now();
    expect(await wrapView(v, slow).interrupt()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(slow.graceMs);
  });

  test("without a native reload it does nothing", async () => {
    const v = fakeView();
    expect(await wrapView(v, fast).interrupt()).toBe(false);
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

// Every op in the daemon's ACTS set acts on the page, and a page handler can
// navigate on anything it does (#51 item 11: a select whose onchange set
// location.href left the next snapshot on the old page). So each one's
// Browser method must run inside the navigation watch: NAV_ARM before the
// action, NAV_COUNT after it. Driven through createHandler, so the op-to-
// method mapping is the daemon's own.
const ACT_ARGS: Partial<Record<Op, string[]>> = {
  click: ["#act-target"],
  type: ["act-text"],
  press: ["act-key"],
  hover: ["#act-target"],
  select: ["#act-target", "v"],
  check: ["#act-target"],
  uncheck: ["#act-target"],
};

describe("every ACTS op runs inside the navigation watch", () => {
  test("the table below covers every ACTS op", () => {
    expect(Object.keys(ACT_ARGS).sort()).toEqual([...ACTS].sort());
  });

  for (const op of ACTS) {
    test(op, async () => {
      const v = fakeView();
      const handle = createHandler(wrapView(v, fast));
      const args = ACT_ARGS[op] ?? [];
      const res = await handle({ id: 1, op, args });
      expect(res.ok).toBe(true);
      // "act" is the call that carries this op's first argument: a native
      // call, or the evaluate of its page script. The dialog shim's reads
      // around the op are "other".
      const seq = v.calls.map(([name, a]) => {
        if (name === "evaluate" && a[0] === NAV_ARM) return "arm";
        if (name === "evaluate" && a[0] === NAV_COUNT) return "count";
        return a.some((x) => String(x).includes(args[0]!)) ? "act" : "other";
      });
      const arm = seq.indexOf("arm");
      expect(arm).toBeGreaterThanOrEqual(0);
      expect(seq.slice(arm + 1, seq.indexOf("count", arm))).toEqual(["act"]);
    });
  }

  // #115: the daemon's timeout message says "may have been delivered" from
  // the moment the action is sent, and "was delivered" once it returned.
  for (const op of ACTS) {
    test(`${op}: phase is idle while arming, acting while the action runs, delivered after it`, async () => {
      const args = ACT_ARGS[op] ?? [];
      const seen: Array<[string, string]> = [];
      let b!: ReturnType<typeof wrapView>;
      const v = fakeView();
      const note = (call: string, a: unknown[]) => {
        if (call === "evaluate" && a[0] === NAV_ARM) seen.push(["arm", b.phase]);
        else if (call === "evaluate" && a[0] === NAV_COUNT) seen.push(["count", b.phase]);
        else if (a.some((x) => String(x).includes(args[0]!))) seen.push(["act", b.phase]);
      };
      const { evaluate, click, type, press } = v;
      v.evaluate = async (e) => { note("evaluate", [e]); return evaluate(e); };
      v.click = async (s, o) => { note("click", [s]); return click(s, o); };
      v.type = async (t) => { note("type", [t]); return type(t); };
      v.press = async (k, o) => { note("press", [k]); return press(k, o); };
      b = wrapView(v, fast);
      expect((await createHandler(b)({ id: 1, op, args })).ok).toBe(true);
      expect(seen).toEqual([["arm", "idle"], ["act", "acting"], ["count", "delivered"]]);
      expect(b.phase).toBe("idle");
    });
  }
});
