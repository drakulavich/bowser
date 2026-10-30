// wrapView() against a fake view.
import { describe, expect, test } from "bun:test";
import { wrapView, type Clock, type NavTiming, type ViewLike } from "../src/browser.ts";
import { ACTS, createHandler, dispatch } from "../src/daemon/server.ts";
import { createSerializer } from "../src/serialize.ts";
import type { Op } from "../src/daemon/protocol.ts";
import { waitFor } from "./helpers/daemons.ts";
import { manualClock } from "./helpers/manual-clock.ts";
import {
  CANCEL_PENDING_NAVIGATION,
  keyCommandScript,
  keyWatchScript,
  LANDED_PAGE,
  ENTRY_KEY,
  LEAVE_INITIAL_DOCUMENT,
  DOC_ID,
  LOAD_STATE,
  MUTE_MEDIA,
  NAV_ARM,
  NAV_COUNT,
  NAV_DESTINATION,
  STOP_LOADING,
  TYPE_TARGET_FOCUSED,
  TYPE_TARGET_MARK,
} from "../src/page-scripts.ts";

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
    navigate: async (url) => {
      calls.push(["navigate", [url]]);
      v.url = url;
    },
    evaluate: async (expr) => {
      calls.push(["evaluate", [expr]]);
      return undefined;
    },
    click: async (s) => {
      calls.push(["click", [s]]);
    },
    type: async (t) => {
      calls.push(["type", [t]]);
    },
    press: async (k, o) => {
      calls.push(["press", o ? [k, o] : [k]]);
    },
    resize: async (w, h) => {
      calls.push(["resize", [w, h]]);
    },
    goBack: async () => {
      calls.push(["goBack", []]);
    },
    goForward: async () => {
      calls.push(["goForward", []]);
    },
    reload: async () => {
      calls.push(["reload", []]);
    },
    screenshot: async () => new Blob(),
    close: () => {},
    /** A navigation lands: url changes, loading ends, onNavigated fires. */
    land(url) {
      v.url = url;
      v.loading = false;
      v.onNavigated?.(url, "");
    },
    ...over,
  };
  return v;
}

describe("wrapView click", () => {
  test("passes its timeout to the view's selector click (#112)", async () => {
    const v = fakeView();
    const seen: unknown[] = [];
    v.click = async (s, o) => {
      seen.push([s, o]);
    };
    await wrapView(v).click("#a", 1234);
    expect(seen).toEqual([["#a", { timeout: 1234 }]]);
  });

  test("a timed-out navigation-arming read never sends the click", async () => {
    let releaseArm!: () => void;
    let armStarted!: () => void;
    const started = new Promise<void>((r) => {
      armStarted = r;
    });
    const v = fakeView({
      evaluate: async (expr) => {
        if (expr === NAV_ARM) {
          armStarted();
          await new Promise<void>((r) => {
            releaseArm = r;
          });
        }
        return undefined;
      },
    });
    const b = wrapView(v, fast);
    const replies: unknown[] = [];
    const handler = createHandler(b);
    dispatch(
      { id: 1, op: "click", args: ["#go"] },
      {
        handle: handler,
        serialize: createSerializer(),
        timeoutMs: 30,
        cancelAction: handler.cancelAction,
        reply: (reply) => {
          replies.push(reply);
        },
      },
    );

    await started;
    await waitFor(() => replies.length >= 1, 3000);
    expect(replies).toEqual([expect.objectContaining({ id: 1, ok: false })]);
    releaseArm();
    // Negative check: no click within 20 ms of the release.
    await Bun.sleep(20);
    expect(v.calls.filter(([op]) => op === "click")).toEqual([]);
  });

  test("Bun's actionability timeout answers as bowser's own timeout of the acting phase (#122)", async () => {
    const v = fakeView({
      click: async (s) => {
        throw new Error(`timeout waiting for '${s}' to be actionable`);
      },
    });
    const handler = createHandler(wrapView(v, fast));
    const replies: unknown[] = [];
    const lane = {
      handle: handler,
      serialize: createSerializer(),
      timeoutMs: 5000,
      reply: (r: unknown) => {
        replies.push(r);
      },
    };
    dispatch({ id: 1, op: "click", args: ["main > button:nth-child(2)"], cmd: "click" }, lane);
    dispatch({ id: 2, op: "click", args: ["#go"], cmd: "fill" }, { ...lane, serialize: createSerializer() });
    await waitFor(() => replies.length === 2);
    expect(replies).toEqual([
      {
        id: 1,
        ok: false,
        error: "'click' timed out after 5000ms; the click may have been delivered, check the page before retrying",
      },
      {
        id: 2,
        ok: false,
        error:
          "'fill' timed out after 5000ms (in its 'click' step); the click may have been delivered but the fill did not finish, check the page before retrying",
      },
    ]);
  });
});

describe("wrapView close", () => {
  test("with a persistent profile, close leaves the page first so its storage is written", async () => {
    const v = fakeView();
    v.close = () => {
      v.calls.push(["close", []]);
    };
    await wrapView(v, undefined, "/p", 0).close();
    expect(v.calls).toEqual([
      ["navigate", ["about:blank"]],
      ["close", []],
    ]);
  });

  // #61: WebKit commits localStorage 500 ms after a write, and Bun kills the
  // browser at exit, so a write made just before close was lost unless close
  // outlasted that window after the page was left.
  test("with a persistent profile, close waits out the storage commit window after leaving the page", async () => {
    let left = 0;
    let closed = 0;
    const v = fakeView({
      navigate: async () => {
        left = Date.now();
      },
    });
    v.close = () => {
      closed = Date.now();
    };
    await wrapView(v, undefined, "/p", 150).close();
    expect(closed - left).toBeGreaterThanOrEqual(150);
  });

  test("an ephemeral view just closes", async () => {
    const v = fakeView();
    v.close = () => {
      v.calls.push(["close", []]);
    };
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
      message() {
        this.messages++;
        const h = held;
        held = [];
        for (const f of h) f();
      },
      /** The host holds this reply until the next message. */
      stall(done: () => void) {
        held.push(done);
      },
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
      get closed() {
        return closed;
      },
      evaluate: (expr: string) =>
        new Promise<unknown>((r) => {
          calls.push("evaluate");
          host.message();
          if (stuck.evaluate) host.stall(() => r(expr));
          else r(expr);
        }),
      resize: (w: number, h: number) =>
        new Promise<void>((r) => {
          calls.push(`resize ${w}x${h}`);
          host.message();
          r();
        }),
      close: () => {
        closed = true;
      },
    };
    return k;
  }
  /** How wrapView gets the kicker: opened on demand, counted. */
  function lazy(k: ReturnType<typeof fakeKicker>, afterMs = 150) {
    const stalls = {
      opens: 0,
      afterMs,
      open: () => {
        stalls.opens++;
        return k;
      },
    };
    return stalls;
  }

  test("a navigate whose reply stalls settles", async () => {
    const host = fakeHost();
    const v = fakeView({
      navigate: (url) =>
        new Promise<void>((r) => {
          host.message();
          host.stall(() => {
            v.land(url);
            r();
          });
        }),
    });
    const clock = manualClock();
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)), clock);
    expect(await clock.fulfilledAt(b.navigate("data:text/html,long"))).toBe(200);
    expect(v.url).toBe("data:text/html,long");
  });

  test("its failure still reaches the caller", async () => {
    const host = fakeHost();
    const v = fakeView({
      navigate: () =>
        new Promise<void>((_, no) => {
          host.message();
          host.stall(() => no(new Error("nav failed")));
        }),
    });
    const clock = manualClock();
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)), clock);
    const nav = b.navigate("data:text/html,long");
    expect(await clock.settledAt(nav)).toBe(200);
    await expect(nav).rejects.toThrow("nav failed");
  });

  // The residual of a navigate-only kick: `state` reads location.href, which
  // is the long URL again (1 in 600 gotos under load).
  test("an evaluate whose reply stalls settles, with its result", async () => {
    const host = fakeHost();
    const v = fakeView({
      evaluate: (expr) =>
        new Promise((r) => {
          host.message();
          host.stall(() => r(`long ${expr}`));
        }),
    });
    const clock = manualClock();
    const b = wrapView(v, fast, undefined, 0, lazy(fakeKicker(host)), clock);
    expect(await clock.fulfilledAt(b.realUrl())).toBe(200);
    const ev = b.evaluate("x");
    await clock.fulfilledAt(ev);
    expect(await ev).toBe("long x");
  });

  test("a navigation an action started lands although its event stalls", async () => {
    const host = fakeHost();
    const v = fakeView({
      click: async () => {
        host.message();
        v.loading = true;
        host.stall(() => v.land("https://x/next"));
      },
    });
    const clock = manualClock();
    const b = wrapView(v, { graceMs: 40, settleMs: 5000 }, undefined, 0, lazy(fakeKicker(host)), clock);
    expect(await clock.fulfilledAt(b.click("a"))).toBeLessThan(5000);
    expect(v.url).toBe("https://x/next");
  });

  test("a kick whose own reply stalls does not stop the kicking", async () => {
    // The reply needs two more messages: each one flushes part of it.
    const host = fakeHost();
    const v = fakeView({
      navigate: () =>
        new Promise<void>((r) => {
          host.message();
          host.stall(() => host.stall(r));
        }),
    });
    const k = fakeKicker(host, { evaluate: true });
    const clock = manualClock();
    const b = wrapView(v, fast, undefined, 0, lazy(k), clock);
    expect(await clock.fulfilledAt(b.navigate("data:text/html,long"))).toBe(300);
    expect(k.calls).toContain("resize 1x1");
  });

  test("kicks only while a call is pending, and close closes the kicker", async () => {
    const host = fakeHost();
    const k = fakeKicker(host);
    const clock = manualClock();
    const b = wrapView(
      fakeView({
        navigate: () =>
          new Promise<void>((r) => {
            clock.setTimeout(r, 400);
          }),
      }),
      fast,
      undefined,
      0,
      lazy(k),
      clock,
    );
    await clock.fulfilledAt(b.navigate("https://slow/"));
    const kicks = k.calls.length;
    expect(kicks).toBeGreaterThan(0);
    // Negative check: no kick once nothing is pending.
    await clock.settledAt(
      new Promise<void>((r) => {
        clock.setTimeout(r, 250);
      }),
    );
    expect(k.calls.length).toBe(kicks);
    await b.close();
    expect(k.closed).toBe(true);
  });

  // The owner's call: a session that never meets the bug does not pay for
  // the second view (a WebContent process, ~25 MB).
  test("calls that answer within afterMs open no kicker", async () => {
    const host = fakeHost();
    const stalls = lazy(fakeKicker(host));
    const clock = manualClock();
    const v = fakeView({
      navigate: async (url) => {
        await new Promise<void>((r) => {
          clock.setTimeout(r, 50);
        });
        v.land(url);
      },
    });
    const b = wrapView(v, fast, undefined, 0, stalls, clock);
    await clock.fulfilledAt(b.navigate("https://x/a"));
    await clock.fulfilledAt(b.evaluate("1"));
    await clock.fulfilledAt(b.click("a"));
    await clock.settledAt(b.screenshot().catch(() => {}));
    // Negative check: no kicker opens after afterMs has passed.
    await clock.settledAt(
      new Promise<void>((r) => {
        clock.setTimeout(r, 300);
      }),
    );
    await b.close();
    expect(stalls.opens).toBe(0);
    expect(b.kickerOpened).toBe(false);
  });

  test("a stalled call opens the kicker after afterMs, and the session keeps it", async () => {
    const host = fakeHost();
    const k = fakeKicker(host);
    const stalls = lazy(k, 300);
    const v = fakeView({
      navigate: (url) =>
        new Promise<void>((r) => {
          host.message();
          host.stall(() => {
            v.land(url);
            r();
          });
        }),
    });
    const clock = manualClock();
    const b = wrapView(v, fast, undefined, 0, stalls, clock);
    // Settling at 300, not at the first kick (100), is the check that no kicker opens before afterMs.
    expect(await clock.fulfilledAt(b.navigate("data:text/html,long-1"))).toBe(300);
    expect(b.kickerOpened).toBe(true);
    expect(await clock.fulfilledAt(b.navigate("data:text/html,long-2"))).toBe(400);
    expect(stalls.opens).toBe(1);
    expect(k.closed).toBe(false);
    await b.close();
    expect(k.closed).toBe(true);
  });
});

const fast = { graceMs: 40, settleMs: 300 };
const onClock = (v: ViewLike, timing: NavTiming, clock: Clock) => wrapView(v, timing, undefined, undefined, undefined, clock);
// For "at once" checks: any wait for a landing costs at least graceMs.
const slow = { graceMs: 1_000, settleMs: 2_000 };

/** The calls without the mute script each landing runs. */
const withoutMute = (calls: Calls): Calls => calls.filter(([n, a]) => !(n === "evaluate" && a[0] === MUTE_MEDIA));
/** The calls an action made, without the watch's own page reads. */
const own = (calls: Calls): Calls => withoutMute(calls).filter(([n, a]) => !(n === "evaluate" && (a[0] === NAV_ARM || a[0] === NAV_COUNT)));

describe("wrapView mute (#227)", () => {
  test("each landing mutes the page's media", async () => {
    const v = fakeView();
    wrapView(v, fast);
    v.land("https://x/a");
    v.land("https://x/b");
    await Bun.sleep(0);
    expect(v.calls).toEqual([
      ["evaluate", [MUTE_MEDIA]],
      ["evaluate", [MUTE_MEDIA]],
    ]);
  });
});

/** A view whose page reports, as WebKit's Navigation API does, that a
 *  cross-document navigation began: `page.navs` is what NAV_COUNT reads.
 *  view.loading stays false, as it does on WebKit for a navigation the page
 *  starts (measured: a link click, a form submit, a script's location change). */
function pageNavView(over: Partial<ViewLike> = {}) {
  const page: { navs: number; to?: string } = { navs: 0 };
  const v = fakeView({
    evaluate: async (expr) => {
      v.calls.push(["evaluate", [expr]]);
      if (expr === NAV_ARM) {
        page.navs = 0;
        return undefined;
      }
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
    const clock = manualClock();
    const v = fakeView();
    v.press = async (k) => {
      v.calls.push(["press", [k]]);
      clock.setTimeout(() => v.land("https://x/submitted"), 10);
    };
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.press("Enter"));
    expect(v.url).toBe("https://x/submitted");
  });

  test("type that stops on lost focus still waits for the navigation its Enter started (#243)", async () => {
    const clock = manualClock();
    const v = fakeView({ evaluate: async (expr) => (expr === TYPE_TARGET_MARK ? true : expr === TYPE_TARGET_FOCUSED ? false : undefined) });
    v.press = async (k) => {
      v.calls.push(["press", [k]]);
      v.loading = true;
      clock.setTimeout(() => v.land("https://x/sent"), 120);
    };
    const b = onClock(v, fast, clock);
    const typed = b.type("first\nsecond");
    await clock.settledAt(typed);
    expect(await typed.catch((e: Error) => [e.message, v.url])).toEqual([
      "type: focus left the editor after line 1 of 2; the rest was not typed",
      "https://x/sent",
    ]);
  });

  test("a bare named key goes as its macOS character, which WebKit takes as a key event (F11, #168)", async () => {
    const v = fakeView();
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    for (const key of ["Tab", "Enter", "ArrowDown", "Escape", "t"]) await clock.fulfilledAt(b.press(key));
    expect(v.calls.filter(([op]) => op === "press")).toEqual([
      ["press", ["\t"]],
      ["press", ["\r"]],
      ["press", ["\uF701"]],
      ["press", ["Escape"]],
      ["press", ["t"]],
    ]);
  });

  // #55: WebKit gets a modifier with the key, and Tab stays the tab character.
  test("press with modifiers passes them to the view", async () => {
    const v = fakeView();
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.press("Tab", ["Shift"]));
    await clock.fulfilledAt(b.press("ArrowLeft", ["Meta"]));
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
      const clock = manualClock();
      await clock.fulfilledAt(onClock(v, fast, clock).press(key, [...mods]));
      const seen = v.calls.filter(([op, args]) => op === "press" || (op === "evaluate" && args[0] !== NAV_ARM && args[0] !== NAV_COUNT));
      expect(seen).toEqual([
        ["evaluate", [keyWatchScript(key)]],
        ["press", [key, { modifiers: [...mods] }]],
        ["evaluate", [keyCommandScript(command)]],
      ]);
    });
  }

  test("other combinations run no command: Control+a, Shift+Meta+a, Meta+c", async () => {
    const v = fakeView();
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.press("a", ["Control"]));
    await clock.fulfilledAt(b.press("a", ["Shift", "Meta"]));
    await clock.fulfilledAt(b.press("c", ["Meta"]));
    expect(v.calls.filter(([op, args]) => op === "evaluate" && args[0] !== NAV_ARM && args[0] !== NAV_COUNT)).toEqual([]);
  });

  test("press Tab still goes through the watch", async () => {
    const v = fakeView();
    const clock = manualClock();
    v.press = async (k) => {
      v.calls.push(["press", [k]]);
      clock.setTimeout(() => v.land("https://x/next"), 10);
    };
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.press("Tab"));
    expect(v.url).toBe("https://x/next");
  });

  test("a failed navigation ends the wait without failing the action", async () => {
    const v = fakeView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      v.loading = true;
      clock.setTimeout(() => {
        v.onNavigationFailed?.(new Error("-999"));
      }, 20);
    };
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.click("#l"))).toBe(20);
    expect(v.url).toBe("https://x/");
  });

  test("an action after a given-up navigation pays the grace window, not settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      v.loading = true;
    };
    const clock = manualClock();
    const b = onClock(v, { graceMs: 20, settleMs: 300 }, clock);
    const gaveUp = await clock.settledAt(b.click("#stuck"));
    expect(v.loading).toBe(true);
    expect((await clock.settledAt(b.click("#next"))) - gaveUp).toBe(20);
  });

  test("click returns after a navigation that lands inside the grace window", async () => {
    const v = fakeView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      clock.setTimeout(() => v.land("https://x/two"), 10);
    };
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.click("#l"));
    expect(v.url).toBe("https://x/two");
  });

  test("click that navigates nowhere returns after the grace window", async () => {
    const v = fakeView();
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.click("#btn"))).toBe(fast.graceMs);
    expect(v.url).toBe("https://x/");
  });

  test("a navigation that starts inside the grace window is awaited past it", async () => {
    const v = fakeView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      v.loading = true;
      clock.setTimeout(() => v.land("https://x/slow"), 120);
    };
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.click("#l"));
    expect(v.url).toBe("https://x/slow");
  });

  test("a navigation that never lands is given up after settleMs", async () => {
    const v = fakeView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      v.loading = true;
    };
    const clock = manualClock();
    const b = onClock(v, { graceMs: 20, settleMs: 60 }, clock);
    expect(await clock.settledAt(b.click("#l"))).toBe(60);
    expect(v.loading).toBe(true);
  });

  test("a navigation the page starts and the server is slow to answer is awaited until it lands", async () => {
    // F10: on WebKit neither view.loading nor onNavigated shows a
    // provisional navigation; only the page's navigate event does.
    const { v, page } = pageNavView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
      clock.setTimeout(() => v.land("https://x/slow"), 150);
    };
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.click("#slow"));
    expect(v.url).toBe("https://x/slow");
  });

  test("the page's signal is armed before the action, so an earlier navigation does not count", async () => {
    const { v, page } = pageNavView();
    page.navs = 1; // left over from a navigation that never landed
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.click("#btn"))).toBe(fast.graceMs);
    expect(v.calls.map(([n, a]) => (n === "evaluate" ? String(a[0]) : n))).toEqual([NAV_ARM, "click", NAV_COUNT]);
  });

  test("a page-started navigation that never lands is given up after settleMs", async () => {
    const { v, page } = pageNavView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
    };
    const clock = manualClock();
    const b = onClock(v, { graceMs: 20, settleMs: 60 }, clock);
    expect(await clock.settledAt(b.click("#never"))).toBe(20 + 60);
  });

  test("a navigation that replaces the one the action started is awaited, not ended by the first one's -999", async () => {
    const { v, page } = pageNavView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
      clock.setTimeout(() => {
        page.navs++;
        v.onNavigationFailed?.(new Error("-999"));
      }, 80);
      clock.setTimeout(() => v.land("https://x/second"), 160);
    };
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.click("#twice"));
    expect(v.url).toBe("https://x/second");
  });

  test("a count read during the wait that a later failure overtakes is read again (#106)", async () => {
    const clock = manualClock();
    let reads = 0;
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        if (expr === NAV_ARM) {
          page.navs = 0;
          return undefined;
        }
        if (expr !== NAV_COUNT) return undefined;
        const n = page.navs;
        if (++reads === 2)
          await new Promise<void>((r) => {
            clock.setTimeout(r, 40);
          });
        return n;
      },
    });
    v.click = async () => {
      page.navs++;
      clock.setTimeout(() => {
        page.navs++;
        v.onNavigationFailed?.(new Error("-999"));
      }, 80);
      clock.setTimeout(() => {
        page.navs++;
        v.onNavigationFailed?.(new Error("-999"));
      }, 100);
      clock.setTimeout(() => v.land("https://x/third"), 200);
    };
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.click("#thrice"));
    expect(v.url).toBe("https://x/third");
  });

  test("a reread that never answers still leaves the wait at settleMs", async () => {
    // Codex's repro: the NAV_COUNT reread after a failure stays pending, and
    // an unbounded await never looked at the deadline again.
    let reads = 0;
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        if (expr === NAV_ARM) {
          page.navs = 0;
          return undefined;
        }
        if (expr === NAV_COUNT && ++reads > 1) return new Promise(() => {});
        return page.navs;
      },
    });
    const clock = manualClock();
    v.click = async () => {
      page.navs++;
      clock.setTimeout(() => v.onNavigationFailed?.(new Error("-999")), 40);
    };
    const b = onClock(v, { graceMs: 20, settleMs: 60 }, clock);
    const at = await clock.settledAt(b.click("#x"));
    expect(reads).toBe(2);
    expect(at).toBe(20 + 60);
  });

  test("a read that act stops waiting for stays tracked: the next evaluate queues behind it instead of failing", async () => {
    // WebKit allows one evaluate per view; a second one while the first is
    // pending throws ERR_INVALID_STATE. On a slow machine the read at the
    // end of the grace window outlived its bound, and the next op's
    // evaluate failed (CI, PR #46).
    let pending = false;
    const log: string[] = [];
    const clock = manualClock();
    const v = fakeView({
      evaluate: async (expr) => {
        if (pending) throw new Error("Invalid state: an evaluate() is already pending");
        log.push(`start ${expr === NAV_COUNT ? "count" : expr === NAV_ARM ? "arm" : expr}`);
        pending = true;
        try {
          if (expr === NAV_COUNT) {
            await new Promise<void>((r) => {
              clock.setTimeout(r, 1000);
            });
            return 0;
          }
          return expr === "1" ? 1 : undefined;
        } finally {
          pending = false;
          log.push(`end ${expr === NAV_COUNT ? "count" : expr === NAV_ARM ? "arm" : expr}`);
        }
      },
    });
    const b = onClock(v, { graceMs: 100, settleMs: 150 }, clock);
    // act stopped waiting for the slow read at its settleMs bound, after the grace.
    expect(await clock.settledAt(b.click("#btn"))).toBe(100 + 150);
    const one = b.evaluate("1");
    expect(await clock.settledAt(one)).toBe(100 + 1000);
    expect(await one).toBe(1);
    expect(log).toEqual(["start arm", "end arm", "start count", "end count", "start 1", "end 1"]);
  });

  test("a failure with no navigation after it still ends the wait", async () => {
    // A 204 answer: the page's navigate event, then only a failure.
    const { v, page } = pageNavView();
    const clock = manualClock();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
      clock.setTimeout(() => v.onNavigationFailed?.(new Error("interrupted")), 60);
    };
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.click("#nocontent"))).toBe(60);
  });

  test("a page that cannot answer the read costs the grace window, not a failure", async () => {
    const v = fakeView({
      evaluate: async () => {
        throw new Error("no longer reachable");
      },
    });
    const b = wrapView(v, fast);
    await b.click("#btn");
    expect(v.url).toBe("https://x/");
  });

  test("back and forward call goBack/goForward, with no page fallback", async () => {
    const v = fakeView();
    const b = wrapView(v, fast);
    await b.back();
    await b.forward();
    expect(own(v.calls)).toEqual([
      ["goBack", []],
      ["goForward", []],
    ]);
  });

  // #127: past the back-forward cache WebKit reports the load's failure after goBack() resolves.
  test("back and forward fail with the failure of the page they go to", async () => {
    const clock = manualClock();
    const failing = async () => {
      clock.setTimeout(() => v.onNavigationFailed?.(new Error("Could not connect to the server.")), 5);
    };
    const v = fakeView({ goBack: failing, goForward: failing });
    const b = onClock(v, fast, clock);
    const back = b.back();
    await clock.settledAt(back);
    await expect(back).rejects.toThrow("Could not connect to the server.");
    const forward = b.forward();
    await clock.settledAt(forward);
    await expect(forward).rejects.toThrow("Could not connect to the server.");
    expect(b.phase).toBe("idle");
  });

  test("back over a cancelled -999 still returns", async () => {
    const clock = manualClock();
    const v = fakeView({
      goBack: async () => {
        clock.setTimeout(() => v.onNavigationFailed?.(new Error(CANCELLED)), 5);
      },
    });
    await clock.fulfilledAt(onClock(v, fast, clock).back());
  });

  test("back that lands returns, though the navigation before it failed", async () => {
    const clock = manualClock();
    const v = fakeView({
      goBack: async () => {
        clock.setTimeout(() => v.land("https://x/previous"), 5);
      },
    });
    const b = onClock(v, fast, clock);
    v.onNavigationFailed?.(new Error("Could not connect to the server."));
    await clock.fulfilledAt(b.back());
    expect(v.url).toBe("https://x/previous");
  });

  // #116: on WebKit a reload shows no sign before it lands: view.loading
  // stays false, the page sees no navigate event, and the server may take
  // longer than the grace window to answer.
  test("reload waits for its landing past the grace and settle windows, as navigate does", async () => {
    let during = "";
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        clock.setTimeout(() => {
          during = b.phase;
          v.land("https://x/");
        }, fast.settleMs + 100);
      },
    });
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.reload())).toBe(fast.settleMs + 100);
    expect(during).toBe("awaiting-navigation");
    expect(b.navigationPending).toBe(false);
  });

  test("reload of a view where nothing has committed does not wait for a landing", async () => {
    const v = fakeView({ reload: async () => {} });
    v.url = "";
    const clock = manualClock();
    const b = onClock(v, slow, clock);
    expect(await clock.settledAt(b.reload())).toBe(slow.graceMs);
  });

  test("a reload that a page script cancels waits for the script's navigation", async () => {
    const clock = manualClock();
    const { v, page } = pageNavView({
      reload: async () => {
        clock.setTimeout(() => {
          page.navs = 1;
          v.onNavigationFailed?.(new Error(CANCELLED));
        }, 30);
        clock.setTimeout(() => v.land("https://x/elsewhere"), 120);
      },
    });
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.reload());
    expect(v.url).toBe("https://x/elsewhere");
  });

  test("reload fails at once when its own failure arrives before reload resolves", async () => {
    const v = fakeView({
      reload: async () => {
        v.onNavigationFailed?.(new Error("Could not connect to the server."));
      },
    });
    const clock = manualClock();
    const b = onClock(v, fast, clock);
    const reloaded = b.reload();
    expect(await clock.settledAt(reloaded)).toBe(0);
    await expect(reloaded).rejects.toThrow("Could not connect to the server.");
  });

  // #123: WebKit reports the reload's own failure 1-5 ms after reload() resolves.
  test("reload fails with its own failure when it arrives after reload resolves", async () => {
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        clock.setTimeout(() => v.onNavigationFailed?.(new Error("Could not connect to the server.")), 3);
      },
    });
    const b = onClock(v, fast, clock);
    const reloaded = b.reload();
    await clock.settledAt(reloaded);
    await expect(reloaded).rejects.toThrow("Could not connect to the server.");
    expect(b.phase).toBe("idle");
  });

  test("reload whose script replacement fails after the cancelled -999 fails with that failure", async () => {
    const clock = manualClock();
    const { v, page } = pageNavView({
      reload: async () => {
        clock.setTimeout(() => {
          page.navs = 1;
          v.onNavigationFailed?.(new Error(CANCELLED));
        }, 3);
        clock.setTimeout(() => v.onNavigationFailed?.(new Error("Could not connect to the server.")), 60);
      },
    });
    const b = onClock(v, fast, clock);
    const reloaded = b.reload();
    await clock.settledAt(reloaded);
    await expect(reloaded).rejects.toThrow("Could not connect to the server.");
  });

  test("reload over a cancelled -999 with nothing after it still returns", async () => {
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        clock.setTimeout(() => v.onNavigationFailed?.(new Error(CANCELLED)), 3);
      },
    });
    const reloaded = onClock(v, fast, clock).reload();
    await clock.settledAt(reloaded);
    await reloaded;
  });

  test("reload waits when the cancelled navigation fails before reload resolves", async () => {
    const clock = manualClock();
    const { v, page } = pageNavView({
      reload: async () => {
        clock.setTimeout(() => {
          page.navs = 1;
          v.onNavigationFailed?.(new Error(CANCELLED));
        }, 10);
        await new Promise<void>((r) => {
          clock.setTimeout(r, 30);
        });
        clock.setTimeout(() => v.land("https://x/elsewhere"), 40);
      },
    });
    const b = onClock(v, fast, clock);
    expect(await clock.settledAt(b.reload())).toBe(30 + 40);
    expect(v.url).toBe("https://x/elsewhere");
  });

  test("reload prefers the native call and waits for its navigation to land", async () => {
    // Native reload() resolves before the reload commits (measured), so the
    // fake resolves at once with loading=true and lands 60 ms later.
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
        v.loading = true;
        clock.setTimeout(() => v.land("https://x/re"), 60);
      },
    });
    const b = onClock(v, fast, clock);
    await clock.settledAt(b.reload());
    expect(own(v.calls)).toEqual([["reload", []]]);
    expect(v.url).toBe("https://x/re");
  });

  test("phase is awaiting-navigation while act waits for a landing", async () => {
    const v = fakeView();
    let during = "";
    const b = wrapView(v, { graceMs: fast.graceMs, settleMs: 5000 });
    v.click = async () => {
      during = b.phase;
      v.loading = true;
    };
    expect(b.phase).toBe("idle");
    const clicked = b.click("#go");
    await waitFor(() => b.phase === "awaiting-navigation", 3000);
    expect([during, b.phase]).toEqual(["acting", "awaiting-navigation"]);
    v.land("https://x/next");
    await clicked;
    expect([v.url, b.phase]).toEqual(["https://x/next", "idle"]);
  });

  test("phase is delivered while the watch waits for a navigation that never begins", async () => {
    let atRead = "";
    const v = fakeView({
      evaluate: async (expr) => {
        if (expr === NAV_COUNT) atRead = b.phase;
        return 0;
      },
    });
    const b = wrapView(v, fast);
    await b.click("#go");
    expect([atRead, b.phase]).toEqual(["delivered", "idle"]);
  });

  test("phase turns awaiting-navigation when the page reports a navigation it started", async () => {
    const { v, page } = pageNavView({
      click: async () => {
        page.navs = 1;
      },
    });
    const b = wrapView(v, fast);
    const clicked = b.click("#go");
    await waitFor(() => b.phase === "awaiting-navigation", 3000);
    expect(b.phase).toBe("awaiting-navigation");
    v.land("https://x/next");
    await clicked;
    expect(b.phase).toBe("idle");
  });

  test("phase resets to idle when the action throws", async () => {
    const v = fakeView({
      click: async () => {
        throw new Error("no element");
      },
    });
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
    const v = fakeView({
      navigate: async (url) => {
        v.onNavigationFailed?.(new Error(CANCELLED));
        setTimeout(() => then(v, url), 30);
        throw new Error(CANCELLED);
      },
    });
    return v;
  }

  test("waits for its own landing instead of failing with the cancelled one's -999", async () => {
    const v = cancelling((v, url) => v.land(url));
    await wrapView(v, fast).navigate("https://x/next");
    expect(v.url).toBe("https://x/next");
  });

  test("its own failure is reported", async () => {
    const b = wrapView(
      cancelling((v) => v.onNavigationFailed?.(new Error("Could not connect to the server."))),
      fast,
    );
    await expect(b.navigate("https://x/next")).rejects.toThrow("Could not connect to the server.");
  });

  test("cancelled itself, it fails with bowser's message, not WebKit's", async () => {
    const b = wrapView(
      cancelling((v) => v.onNavigationFailed?.(new Error(CANCELLED))),
      fast,
    );
    const err = await b.navigate("https://x/next").then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe("navigate: the navigation to https://x/next was cancelled by another navigation; run 'bowser snapshot' to see where the page is");
  });

  test("any other failure is reported at once", async () => {
    const v = fakeView({
      navigate: async () => {
        throw new Error("bad URL");
      },
    });
    await expect(wrapView(v, fast).navigate("nope")).rejects.toThrow("bad URL");
  });
});

// ET-13, measured on WebKit (Bun 1.4.4): navigate() answers whichever
// navigation ends first, so a page that navigates itself by script can
// stand in for the one asked for, with or without a failure first.
describe("navigate while the page navigates itself (ET-13)", () => {
  const FORM = "https://x/form";
  const BOUNCED = "https://x/jsbounce?n=5";
  const LEFT = "navigate: the navigation to https://x/form was cancelled by another navigation; run 'bowser snapshot' to see where the page is";
  /** `key` is the history entry's: a location.replace keeps it, a navigate() pushes a new one (measured, Bun 1.4.4). */
  type Page = { href: string; referrer: string; key: string };
  /** A page on the bouncing script page; `go` plays WebKit's answer to navigate(). */
  function bouncing(go: (v: Fake, page: Page) => Promise<void>) {
    const page: Page = { href: "https://x/jsbounce?n=4", referrer: "https://x/jsbounce?n=3", key: "left" };
    const v = fakeView({
      navigate: () => go(v, page),
      evaluate: async (expr) => (expr === LANDED_PAGE ? [page.href, page.referrer, page.key] : expr === ENTRY_KEY ? page.key : undefined),
    });
    v.url = page.href;
    return v;
  }
  const landOn = (v: Fake, page: Page, href: string, referrer: string, key = page.key) => {
    page.href = href;
    page.referrer = referrer;
    page.key = key;
    v.land(href);
  };
  const outcome = async (v: Fake, clock: ReturnType<typeof manualClock>, url = FORM) => {
    const p = onClock(v, fast, clock).navigate(url);
    const at = await clock.settledAt(p);
    const error = await p.then(
      () => undefined,
      (e: Error) => e.message,
    );
    return { at, error };
  };

  test("the page's own navigation landing in place of the one asked for fails it", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, BOUNCED, "https://x/jsbounce?n=4"));
    expect(await outcome(v, clock)).toEqual({ at: 0, error: LEFT });
  });

  test("the one asked for cancelled, then the page's own landing, fails it", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => {
      v.onNavigationFailed?.(new Error(CANCELLED));
      clock.setTimeout(() => landOn(v, page, BOUNCED, "https://x/jsbounce?n=4"), 5);
      throw new Error(CANCELLED);
    });
    expect((await outcome(v, clock)).error).toBe(LEFT);
  });

  test("WebKit's 'Frame load interrupted' for the same, fails it with bowser's message", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => {
      v.onNavigationFailed?.(new Error("Frame load interrupted"));
      clock.setTimeout(() => landOn(v, page, BOUNCED, "https://x/jsbounce?n=4"), 5);
      throw new Error("Frame load interrupted");
    });
    expect((await outcome(v, clock)).error).toBe(LEFT);
  });

  test("a server redirect from a fresh view lands elsewhere with no referrer, and succeeds", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, FORM, ""));
    v.url = "";
    expect(await outcome(v, clock, "https://x/r302")).toEqual({ at: 0, error: undefined });
  });

  test("a landing on the requested URL with its escapes decoded is the one asked for", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, "https://x/~user", "https://x/jsbounce?n=4"));
    expect((await outcome(v, clock, "https://x/%7Euser")).error).toBeUndefined();
  });

  test("the page asked for, sent on twice by its own scripts before the read, succeeds", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, "https://x/jsbounce?n=2", "https://x/jsbounce?n=1", "ours"));
    expect((await outcome(v, clock, "https://x/jsbounce")).error).toBeUndefined();
  });

  // CI run 40867818123: goto /late from /jsbounce reported "navigated to …/jsbounce?n=2".
  test("the page's own navigation, moved on again before the read, still fails it", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => {
      landOn(v, page, "https://x/jsbounce?n=1", "https://x/jsbounce");
      landOn(v, page, "https://x/jsbounce?n=2", "https://x/jsbounce?n=1");
    });
    v.url = "https://x/jsbounce";
    expect(await outcome(v, clock)).toEqual({ at: 0, error: LEFT });
  });

  // CI runs 40879557760 and 40879887529: every wrong success had a landing read that failed.
  test("a landing read that fails because the page moved on again is read once more, and fails it", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, BOUNCED, "https://x/jsbounce?n=4"));
    const answer = v.evaluate;
    let failed = false;
    v.evaluate = async (expr) => {
      if (expr !== LANDED_PAGE || failed) return answer(expr);
      failed = true;
      v.land("https://x/jsbounce?n=6");
      throw new Error("the page navigated during the read");
    };
    expect(await outcome(v, clock)).toEqual({ at: 0, error: LEFT });
  });

  // CI run 40881043905: the read failed with no landing during it, view.url already on a bounce page.
  test("a landing read that fails on a page other than the one asked for is read once more, and fails it", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, BOUNCED, "https://x/jsbounce?n=4"));
    const answer = v.evaluate;
    let failed = false;
    v.evaluate = async (expr) => {
      if (expr !== LANDED_PAGE || failed) return answer(expr);
      failed = true;
      throw new Error("the page is navigating");
    };
    expect(await outcome(v, clock)).toEqual({ at: 0, error: LEFT });
  });

  test("a goto to the page already shown keeps its history entry, and moved on by its script, succeeds", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => landOn(v, page, "https://x/jsbounce?n=2", "https://x/jsbounce?n=1"));
    v.url = "https://x/jsbounce";
    expect((await outcome(v, clock, "https://x/jsbounce")).error).toBeUndefined();
  });

  test("a landing that names the URL asked for before its page is there waits for the next landing", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => {
      page.href = BOUNCED;
      page.referrer = "https://x/jsbounce?n=4";
      v.land(FORM);
      clock.setTimeout(() => landOn(v, page, FORM, ""), 50);
    });
    const p = onClock(v, fast, clock).navigate(FORM);
    expect(await clock.fulfilledAt(p)).toBe(50);
  });

  test("a pushState right after the landing does not wait", async () => {
    const clock = manualClock();
    const v = bouncing(async (v, page) => {
      landOn(v, page, FORM, "");
      page.href = "https://x/form/step-2";
    });
    expect(await outcome(v, clock)).toEqual({ at: 0, error: undefined });
  });
});

describe("a navigation a previous command left pending", () => {
  const slow = { graceMs: 20, settleMs: 60 };
  /** A view whose `#send` starts a page navigation to `to` that nothing
   *  answers; with `to` null the page cannot say where it goes. */
  function submitted(to: string | null = "https://x/never") {
    const { v, page } = pageNavView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      if (s === "#send") {
        page.navs++;
        page.to = to ?? undefined;
      }
    };
    return v;
  }
  const stillLoading = (url: string) => `page is still loading ${url}; retry later, or run 'bowser close'`;
  const clicks = (v: Fake) => v.calls.filter(([n]) => n === "click").map(([, a]) => a[0]);
  /** Settles once `cond` holds, polling on `clock`; settledAt throws if it never does. */
  const until = (clock: ReturnType<typeof manualClock>, cond: () => boolean) =>
    clock.fulfilledAt(
      new Promise<void>((r) => {
        const poll = () => (cond() ? r() : clock.setTimeout(poll, 1));
        poll();
      }),
    );

  test("is pending after act gives up on it, until a landing or a failure", async () => {
    for (const end of ["landed", "failed"] as const) {
      const v = submitted();
      const clock = manualClock();
      const b = onClock(v, slow, clock);
      expect(b.navigationPending).toBe(false);
      await clock.fulfilledAt(b.click("#send"));
      expect(b.navigationPending).toBe(true);
      if (end === "landed") v.land("https://x/never");
      else {
        v.onNavigationFailed?.(new Error("Frame load interrupted"));
        await until(clock, () => !b.navigationPending);
      }
      expect([end, b.navigationPending]).toEqual([end, false]);
    }
  });

  test("stays pending when a script replaces it after the watch ended, until the replacement lands (#98)", async () => {
    const { v, page } = pageNavView();
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      page.navs++;
      page.to = "https://x/never";
    };
    const clock = manualClock();
    const b = onClock(v, slow, clock);
    await clock.fulfilledAt(b.click("#send"));
    page.navs++;
    page.to = "https://x/never2";
    v.onNavigationFailed?.(new Error("-999"));
    // Negative check: the failure does not clear it once the page's count is read.
    await clock.settledAt(
      new Promise<void>((r) => {
        clock.setTimeout(r, 100);
      }),
    );
    expect(b.navigationPending).toBe(true);
    v.land("https://x/never2");
    expect(b.navigationPending).toBe(false);
  });

  test("two failures read NAV_COUNT in order and do not leave a failed replacement pending", async () => {
    let countReads = 0;
    let startFirstFailureRead!: () => void;
    let releaseFirstFailureRead!: () => void;
    const firstFailureReadStarted = new Promise<void>((resolve) => {
      startFirstFailureRead = resolve;
    });
    const firstFailureReadGate = new Promise<void>((resolve) => {
      releaseFirstFailureRead = resolve;
    });
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        if (expr === NAV_ARM) {
          page.navs = 0;
          return undefined;
        }
        if (expr === NAV_COUNT && ++countReads === 2) {
          startFirstFailureRead();
          await firstFailureReadGate;
        }
        if (expr === NAV_COUNT) return page.navs;
        if (expr === NAV_DESTINATION) return page.to;
        return undefined;
      },
    });
    v.click = async () => {
      page.navs++;
    };
    const clock = manualClock();
    const b = onClock(v, slow, clock);
    await clock.fulfilledAt(b.click("#send"));

    v.onNavigationFailed?.(new Error("-999"));
    await firstFailureReadStarted;
    page.navs++;
    v.onNavigationFailed?.(new Error("-999"));
    releaseFirstFailureRead();

    await until(clock, () => !b.navigationPending);
    expect(countReads).toBe(3);
    expect(b.navigationPending).toBe(false);
    expect(v.calls.filter(([name, args]) => name === "evaluate" && args[0] === NAV_COUNT)).toHaveLength(3);
  });

  // #106: started navigations (NAV_COUNT) against finished ones (landings), not the count last seen.
  test("a count read late, already counting a third navigation, does not clear the pending one", async () => {
    let countReads = 0;
    let startLateRead!: () => void;
    let releaseLateRead!: () => void;
    const lateReadStarted = new Promise<void>((resolve) => {
      startLateRead = resolve;
    });
    const lateReadGate = new Promise<void>((resolve) => {
      releaseLateRead = resolve;
    });
    const { v, page } = pageNavView({
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        if (expr === NAV_ARM) {
          page.navs = 0;
          return undefined;
        }
        if (expr === NAV_COUNT && ++countReads === 2) {
          startLateRead();
          await lateReadGate;
        }
        if (expr === NAV_COUNT) return page.navs;
        return undefined;
      },
    });
    v.click = async () => {
      page.navs++;
    };
    const clock = manualClock();
    const b = onClock(v, slow, clock);
    await clock.fulfilledAt(b.click("#send"));

    page.navs++;
    v.onNavigationFailed?.(new Error("-999"));
    await lateReadStarted;
    page.navs++;
    v.onNavigationFailed?.(new Error("-999"));
    releaseLateRead();
    await until(clock, () => countReads === 3);
    await clock.settledAt(
      new Promise<void>((r) => {
        clock.setTimeout(r, 100);
      }),
    );

    expect(b.navigationPending).toBe(true);
    v.land("https://x/third");
    expect(b.navigationPending).toBe(false);
  });

  test("an action that navigates nowhere leaves nothing pending", async () => {
    const v = submitted();
    const clock = manualClock();
    const b = onClock(v, slow, clock);
    await clock.fulfilledAt(b.click("#other"));
    expect(b.navigationPending).toBe(false);
  });

  /** createHandler and its view on one manual clock; `send` drives the clock until the reply. */
  function onHandler(v: Fake) {
    const clock = manualClock();
    const handle = createHandler(onClock(v, slow, clock), {}, clock);
    const send = async (req: Parameters<typeof handle>[0], inMs?: number) => {
      const reply = handle(req, inMs === undefined ? undefined : clock.now() + inMs);
      await clock.fulfilledAt(reply);
      return reply;
    };
    return { clock, send };
  }

  test("an action waits for a navigation a previous command left pending, then fails with 'page is still loading'", async () => {
    const v = submitted();
    const { clock, send } = onHandler(v);
    expect((await send({ id: 1, op: "click", args: ["#send"] })).ok).toBe(true);
    const t0 = clock.now();
    const res = await send({ id: 2, op: "click", args: ["#b"] }, 150);
    expect(res).toEqual({ id: 2, ok: false, error: stillLoading("https://x/never") });
    expect(clock.now() - t0).toBe(150);
    expect(clicks(v)).toEqual(["#send"]);
  });

  test("a page that cannot say where its navigation goes is named by the view's url", async () => {
    const v = submitted(null);
    const { send } = onHandler(v);
    await send({ id: 1, op: "click", args: ["#send"] });
    const res = await send({ id: 2, op: "click", args: ["#b"] }, 50);
    expect(res.error).toBe(stillLoading("https://x/"));
  });

  test("an action waits for a pending navigation that lands, then acts on the new page", async () => {
    const v = submitted();
    const { clock, send } = onHandler(v);
    await send({ id: 1, op: "click", args: ["#send"] });
    clock.setTimeout(() => v.land("https://x/answered"), 100);
    const res = await send({ id: 2, op: "click", args: ["#b"] }, 2000);
    expect(res.ok).toBe(true);
    expect(clicks(v)).toEqual(["#send", "#b"]);
    expect(v.url).toBe("https://x/answered");
  });

  for (const op of ACTS) {
    test(`${op} waits for a pending navigation, as every ACTS op does`, async () => {
      const v = submitted();
      const { send } = onHandler(v);
      await send({ id: 1, op: "click", args: ["#send"] });
      const res = await send({ id: 2, op, args: ACT_ARGS[op] ?? [] }, 30);
      expect(res.error).toBe(stillLoading("https://x/never"));
    });
  }

  for (const op of ["evaluate", "reload", "back", "navigate"] as const) {
    test(`${op} does not wait for a pending navigation`, async () => {
      const v = submitted();
      const { clock, send } = onHandler(v);
      v.reload = async () => {
        clock.setTimeout(() => v.land(v.url), 5);
      };
      await send({ id: 1, op: "click", args: ["#send"] });
      const res = await send({ id: 2, op, args: op === "evaluate" ? ["1"] : op === "navigate" ? ["https://x/b"] : [] }, 30);
      expect(res.error).toBeUndefined();
    });
  }
});

describe("wrapView interrupt", () => {
  test("reloads the page with the native call alone, and waits for it to land", async () => {
    // Measured on WebKit: a pending evaluate() makes a second one throw
    // ERR_INVALID_STATE, so the interrupt must not evaluate anything.
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
        clock.setTimeout(() => v.land("https://x/"), 30);
      },
    });
    const interrupted = onClock(v, fast, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(30);
    expect(await interrupted).toBe(true);
    expect(withoutMute(v.calls)).toEqual([["reload", []]]);
  });

  test("counts a successful landing that happens before reload resolves", async () => {
    const v = fakeView({
      reload: async () => {
        v.land("https://x/reloaded");
      },
    });
    expect(await wrapView(v, fast).interrupt()).toBe(true);
  });

  test("a reload that never settles ends the interrupt at settleMs", async () => {
    const v = fakeView({ reload: () => new Promise<void>(() => {}) });
    const clock = manualClock();
    const interrupted = onClock(v, { graceMs: 20, settleMs: 300 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(300);
    expect(await interrupted).toBe(false);
  });

  test("interrupt waits past the cancelled navigation's failure", async () => {
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        v.onNavigationFailed?.(new Error("-999"));
        clock.setTimeout(() => v.land("https://x/"), 100);
      },
    });
    const interrupted = onClock(v, fast, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(100);
    expect(await interrupted).toBe(true);
  });

  test("interrupt returns false when nothing lands", async () => {
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
      },
    });
    const clock = manualClock();
    const interrupted = onClock(v, { graceMs: 20, settleMs: 50 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(50);
    expect(await interrupted).toBe(false);
  });

  test("interrupt returns false when only the failure lands", async () => {
    const v = fakeView({
      reload: async () => {
        v.onNavigationFailed?.(new Error("-999"));
      },
    });
    const b = wrapView(v, { graceMs: 20, settleMs: 50 });
    expect(await b.interrupt()).toBe(false);
  });

  test("a second landing within settleMs frees the view too", async () => {
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        v.onNavigationFailed?.(new Error("-999"));
        clock.setTimeout(() => v.onNavigationFailed?.(new Error("-999")), 20);
      },
    });
    const interrupted = onClock(v, fast, clock).interrupt();
    await clock.settledAt(interrupted);
    expect(await interrupted).toBe(true);
  });

  // Measured on WebKit (#78, Task 1): while a selector click is hung on a
  // pending page navigation, reload() throws ERR_INVALID_STATE, and a script
  // location.replace frees the view (5 of 5).
  test("a refused reload falls back to a script that cancels the pending navigation", async () => {
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
        throw new Error("ERR_INVALID_STATE: a navigation is already pending");
      },
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        v.onNavigationFailed?.(new Error("-999"));
        clock.setTimeout(() => v.land("https://x/"), 20);
        return "https://x/";
      },
    });
    const interrupted = onClock(v, fast, clock).interrupt();
    await clock.settledAt(interrupted);
    expect(await interrupted).toBe(true);
    expect(withoutMute(v.calls)).toEqual([
      ["reload", []],
      ["evaluate", [CANCEL_PENDING_NAVIGATION]],
    ]);
  });

  test("the fallback script bypasses wrapView's evaluate queue", async () => {
    let first = true;
    const clock = manualClock();
    const v = fakeView({
      reload: async () => {
        throw new Error("ERR_INVALID_STATE: a navigation is already pending");
      },
      evaluate: (expr) => {
        v.calls.push(["evaluate", [expr]]);
        if (first) {
          first = false;
          return new Promise(() => {});
        }
        clock.setTimeout(() => v.land("https://x/"), 10);
        return Promise.resolve(1);
      },
    });
    const b = onClock(v, fast, clock);
    void b.evaluate("stuck");
    const interrupted = b.interrupt();
    await clock.settledAt(interrupted);
    expect(await interrupted).toBe(true);
    expect(v.calls.at(-1)).toEqual(["evaluate", [CANCEL_PENDING_NAVIGATION]]);
  });

  test("a fallback script that never answers ends the interrupt at settleMs", async () => {
    const v = fakeView({
      reload: async () => {
        throw new Error("ERR_INVALID_STATE: a navigation is already pending");
      },
      evaluate: () => new Promise(() => {}),
    });
    const clock = manualClock();
    const interrupted = onClock(v, { graceMs: 20, settleMs: 300 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(300);
    expect(await interrupted).toBe(false);
  });

  test("a refused reload and a refused script return false at once", async () => {
    const v = fakeView({
      reload: async () => {
        throw new Error("ERR_INVALID_STATE: a navigation is already pending");
      },
      evaluate: async () => {
        throw new Error("Invalid state: an evaluate() is already pending");
      },
    });
    const clock = manualClock();
    const interrupted = onClock(v, slow, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(0);
    expect(await interrupted).toBe(false);
  });

  // #48, measured on WebKit (Bun 1.4.2): before the first commit (url "")
  // reload() does nothing and navigate() is refused while one is pending;
  // the initial document still runs a script, and leaving it cancels the
  // stuck navigation (-999).
  test("before anything committed, the page leaves for about:blank instead of reloading", async () => {
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
      },
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        v.onNavigationFailed?.(new Error("-999"));
        return 1;
      },
    });
    v.url = "";
    const clock = manualClock();
    const interrupted = onClock(v, slow, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(0);
    expect(await interrupted).toBe(true);
    expect(v.calls).toEqual([["evaluate", [LEAVE_INITIAL_DOCUMENT]]]);
  });

  // #67, measured on a bare WebView (Bun 1.4.2): with an evaluate pending on
  // the initial document, WebKit refuses a second evaluate at once, reload()
  // does nothing, and navigate("about:blank") frees the stuck one (~3.2 s).
  test("before anything committed, an evaluate refused because one is pending falls back to navigating to about:blank", async () => {
    const v = fakeView({
      reload: async () => {
        v.calls.push(["reload", []]);
      },
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        throw new Error("Invalid state: an evaluate() is already pending");
      },
    });
    v.url = "";
    const clock = manualClock();
    expect(await clock.settledAt(onClock(v, slow, clock).interrupt())).toBe(0);
    expect(v.calls).toEqual([
      ["evaluate", [LEAVE_INITIAL_DOCUMENT]],
      ["navigate", ["about:blank"]],
    ]);
  });

  test("a stuck initial-document evaluate and navigation are each bounded", async () => {
    const v = fakeView({
      evaluate: () => new Promise<unknown>(() => {}),
      navigate: () => new Promise<void>(() => {}),
    });
    v.url = "";
    const clock = manualClock();
    const interrupted = onClock(v, { graceMs: 20, settleMs: 300 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(300 + 300);
    expect(await interrupted).toBe(false);
  });

  test("the about:blank fallback is awaited until it settles", async () => {
    const clock = manualClock();
    const v = fakeView({
      evaluate: async () => {
        throw new Error("Invalid state: an evaluate() is already pending");
      },
      navigate: () =>
        new Promise<void>((r) => {
          clock.setTimeout(r, 40);
        }),
    });
    v.url = "";
    const interrupted = onClock(v, { graceMs: 20, settleMs: 300 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(40);
    expect(await interrupted).toBe(true);
  });

  test("an about:blank fallback that never settles ends the interrupt at settleMs", async () => {
    const v = fakeView({
      evaluate: async () => {
        throw new Error("Invalid state: an evaluate() is already pending");
      },
      navigate: () => new Promise<void>(() => {}),
    });
    v.url = "";
    const clock = manualClock();
    const interrupted = onClock(v, { graceMs: 20, settleMs: 300 }, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(300);
    expect(await interrupted).toBe(false);
  });

  test("an about:blank fallback that is refused ends the interrupt", async () => {
    const v = fakeView({
      evaluate: async () => {
        throw new Error("Invalid state: an evaluate() is already pending");
      },
      navigate: async () => {
        throw new Error("Invalid state: a navigation is already pending");
      },
    });
    v.url = "";
    const clock = manualClock();
    const interrupted = onClock(v, slow, clock).interrupt();
    expect(await clock.settledAt(interrupted)).toBe(0);
    expect(await interrupted).toBe(false);
  });
});

describe("wrapView watchNavigation", () => {
  test("a landing reports a navigation, with no page call of its own", async () => {
    const v = fakeView();
    const b = wrapView(v);
    let navigated = 0;
    b.watchNavigation(() => {
      navigated++;
    });
    await b.navigate("https://x/1");
    v.land("https://x/1");
    expect(navigated).toBe(1);
    // navigate's own reads: the load cap's baseline (ET-52), the history entry left and the page it landed on (ET-13); nothing after the landing.
    expect(v.calls).toEqual([
      ["evaluate", [DOC_ID]],
      ["evaluate", [ENTRY_KEY]],
      ["navigate", ["https://x/1"]],
      ["evaluate", [LANDED_PAGE]],
    ]);
  });

  test("an action whose navigation starts reports it before the navigation lands", async () => {
    const v = fakeView();
    const seen: string[] = [];
    const clock = manualClock();
    v.click = async () => {
      v.loading = true;
      clock.setTimeout(() => {
        seen.push("landed");
        v.land("https://x/2");
      }, 60);
    };
    const b = onClock(v, { graceMs: 40, settleMs: 300 }, clock);
    b.watchNavigation(() => seen.push("navigation"));
    await clock.fulfilledAt(b.click("a"));
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
      v.evaluate = async (e) => {
        note("evaluate", [e]);
        return evaluate(e);
      };
      v.click = async (s, o) => {
        note("click", [s]);
        return click(s, o);
      };
      v.type = async (t) => {
        note("type", [t]);
        return type(t);
      };
      v.press = async (k, o) => {
        note("press", [k]);
        return press(k, o);
      };
      b = wrapView(v, fast);
      expect((await createHandler(b)({ id: 1, op, args })).ok).toBe(true);
      expect(seen).toEqual([
        ["arm", "idle"],
        ["act", "acting"],
        ["count", "delivered"],
      ]);
      expect(b.phase).toBe("idle");
    });
  }
});

// ET-52: a subresource that never finishes holds `load`, and navigate() with
// it. Once the new document is parsed, navigate waits LOAD_CAP_MS more and
// returns with the load still running; the next command stops it first.
describe("navigate caps its wait for load (ET-52)", () => {
  /** A page that commits a new document (id 2) 50 ms after navigate()
   *  and never fires load. stop() ends loading at once and rejects the pending
   *  navigate with -999 5 ms later, as WebKit does (Bun 1.4.4). */
  function hangingLoad(
    clock: ReturnType<typeof manualClock>,
    opts: { origin?: unknown; state?: string; loadAt?: number; read?: (expr: string) => Promise<unknown> | undefined } = {},
  ) {
    const page = { origin: 1 as number, state: "complete" };
    let fail: ((err: Error) => void) | undefined;
    const v = fakeView({
      navigate: (url) => {
        v.calls.push(["navigate", [url]]);
        v.loading = true;
        clock.setTimeout(() => {
          page.origin = 2;
          page.state = opts.state ?? "interactive";
        }, 50);
        return new Promise<void>((resolve, reject) => {
          fail = reject;
          if (opts.loadAt !== undefined)
            clock.setTimeout(() => {
              fail = undefined;
              v.land(url);
              resolve();
            }, opts.loadAt);
        });
      },
      evaluate: async (expr) => {
        v.calls.push(["evaluate", [expr]]);
        const custom = opts.read?.(expr);
        if (custom) return custom;
        if (expr === DOC_ID) return "origin" in opts ? opts.origin : page.origin;
        if (expr === LOAD_STATE) return [page.origin, page.state];
        if (expr === STOP_LOADING && fail) {
          const reject = fail;
          fail = undefined;
          v.loading = false;
          clock.setTimeout(() => {
            const err = new Error(CANCELLED);
            v.onNavigationFailed?.(err);
            reject(err);
          }, 5);
        }
        return undefined;
      },
    });
    return { v, page };
  }
  const evaluated = (v: Fake, expr: string) => v.calls.filter(([n, a]) => n === "evaluate" && a[0] === expr).length;
  /** The calls past the first `skip`, without the watch's own reads. */
  const after = (v: Fake, skip: number) =>
    withoutMute(v.calls.slice(skip)).filter(
      ([n, a]) => !(n === "evaluate" && (a[0] === NAV_ARM || a[0] === NAV_COUNT || a[0] === LOAD_STATE || a[0] === DOC_ID || a[0] === ENTRY_KEY)),
    );

  test("answers 5 s after the new document is parsed and leaves the load running", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    const b = onClock(v, fast, clock);
    const at = await clock.fulfilledAt(b.navigate("https://x/hang"));
    // Parsed at the first read after 50 ms (100), capped one read past 5100.
    expect(at).toBeGreaterThanOrEqual(5100);
    expect(at).toBeLessThan(5300);
    expect(evaluated(v, STOP_LOADING)).toBe(0);
    expect(v.loading).toBe(true);
  });

  // CI run 40854804772: one document's timeOrigin read 1793268461382, then 1793268461383.0002, then 1793268461382.
  test("a document whose performance.timeOrigin moves between reads is still capped 5 s after it is parsed", async () => {
    const clock = manualClock();
    let reads = 0;
    const { v, page } = hangingLoad(clock, {
      read: (expr) => {
        if (!expr.includes("performance.timeOrigin")) return undefined;
        const origin = page.origin + (++reads % 2 ? 0 : 1.0002);
        return Promise.resolve(expr.includes("readyState") ? [origin, page.state] : origin);
      },
    });
    const b = onClock(v, fast, clock);
    const at = await clock.fulfilledAt(b.navigate("https://x/hang"), 8000);
    expect(at).toBeGreaterThanOrEqual(5100);
    expect(at).toBeLessThan(5300);
  });

  // #248 review: the id is stored on the page's own document, which the page can make non-extensible.
  for (const sealed of ["old", "new"] as const)
    test(`with the ${sealed} document made non-extensible by the page, the new one is still capped 5 s after it is parsed`, async () => {
      const clock = manualClock();
      const docs = { 1: { readyState: "complete" } as object, 2: { readyState: "interactive" } as object };
      Object.preventExtensions(docs[sealed === "old" ? 1 : 2]);
      const { v, page } = hangingLoad(clock, {
        read: (expr) =>
          expr === DOC_ID || expr === LOAD_STATE ? Promise.resolve(new Function("document", `return (${expr})`)(docs[page.origin as 1 | 2])) : undefined,
      });
      const b = onClock(v, fast, clock);
      const at = await clock.fulfilledAt(b.navigate("https://x/hang"), 8000);
      expect(at).toBeGreaterThanOrEqual(5100);
      expect(at).toBeLessThan(5300);
    });

  test("mutes the new document once it is parsed, before answering, though it never lands (#227)", async () => {
    const clock = manualClock();
    const muted: number[] = [];
    const { v } = hangingLoad(clock, {
      read: (expr) => {
        if (expr === MUTE_MEDIA) muted.push(clock.now());
        return undefined;
      },
    });
    const b = onClock(v, fast, clock);
    const at = await clock.fulfilledAt(b.navigate("https://x/hang"));
    // Parsed at the first read after 50 ms (100).
    expect(muted).toHaveLength(1);
    expect(muted[0]).toBeGreaterThanOrEqual(100);
    expect(muted[0]).toBeLessThan(at);
  });

  test("the next action stops the load first and waits for the stop's -999, then for its own navigation", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    v.click = async (s) => {
      v.calls.push(["click", [s]]);
      clock.setTimeout(() => v.land("https://x/next"), 30);
    };
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.navigate("https://x/hang"));
    const skip = v.calls.length;
    const start = clock.now();
    const done = await clock.fulfilledAt(b.click("#l"));
    expect(after(v, skip)).toEqual([
      ["evaluate", [STOP_LOADING]],
      ["click", ["#l"]],
    ]);
    // The stop's -999 lands 5 ms in; the click's own landing 30 ms after the click.
    expect(done - start).toBeGreaterThanOrEqual(35);
    expect(v.url).toBe("https://x/next");
  });

  test("the next navigate stops the load before it sends its own", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.navigate("https://x/hang"));
    const skip = v.calls.length;
    void b.navigate("https://x/second").catch(() => {});
    await clock.settledAt(new Promise((r) => clock.setTimeout(() => r(undefined), 100)));
    expect(after(v, skip)).toEqual([
      ["evaluate", [STOP_LOADING]],
      ["navigate", ["https://x/second"]],
    ]);
  });

  test("back stops the load first and waits for the history page's landing, not the stop's -999", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    v.goBack = async () => {
      v.calls.push(["goBack", []]);
      clock.setTimeout(() => v.land("https://x/prev"), 30);
    };
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.navigate("https://x/hang"));
    const skip = v.calls.length;
    const start = clock.now();
    const done = await clock.fulfilledAt(b.back());
    expect(after(v, skip)).toEqual([
      ["evaluate", [STOP_LOADING]],
      ["goBack", []],
    ]);
    expect(done - start).toBeGreaterThanOrEqual(35);
    expect(v.url).toBe("https://x/prev");
  });

  test("close on a profile session stops the load before it leaves for about:blank", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    const b = wrapView(v, fast, "/tmp/profile", 0, undefined, clock);
    await clock.fulfilledAt(b.navigate("https://x/hang"));
    const skip = v.calls.length;
    void b.close();
    await clock.settledAt(new Promise((r) => clock.setTimeout(() => r(undefined), 100)));
    expect(after(v, skip)).toEqual([
      ["evaluate", [STOP_LOADING]],
      ["navigate", ["about:blank"]],
    ]);
  });

  test("a load that finished by itself is not stopped by the next command", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    const b = onClock(v, fast, clock);
    await clock.fulfilledAt(b.navigate("https://x/hang"));
    v.loading = false;
    await clock.settledAt(b.click("#l"));
    expect(evaluated(v, STOP_LOADING)).toBe(0);
  });

  test("a page that loads within the cap leaves nothing to stop", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, { loadAt: 3000 });
    const b = onClock(v, fast, clock);
    expect(await clock.fulfilledAt(b.navigate("https://x/slow"))).toBe(3000);
    // Past the watcher's last read, which ends it.
    await clock.settledAt(new Promise((r) => clock.setTimeout(() => r(undefined), 1000)));
    v.loading = true;
    await clock.settledAt(b.click("#l"));
    expect(evaluated(v, STOP_LOADING)).toBe(0);
  });

  test("a document that stays loading keeps navigate waiting", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, { state: "loading" });
    const b = onClock(v, fast, clock);
    await expect(clock.settledAt(b.navigate("https://x/never-parsed"), 8000)).rejects.toThrow("still pending at clock");
    expect(clock.now()).toBeGreaterThan(6000);
  });

  // Greptile on #214: a document created after the stop passed as the page's own.
  test("a document that navigates on restarts the 5 s, and holds navigate while it is still loading", async () => {
    const clock = manualClock();
    const { v, page } = hangingLoad(clock);
    clock.setTimeout(() => {
      page.origin = 3;
      page.state = "loading";
    }, 3000);
    clock.setTimeout(() => {
      page.state = "interactive";
    }, 7000);
    const b = onClock(v, fast, clock);
    const at = await clock.fulfilledAt(b.navigate("https://x/hang"));
    // Parsed at 7000, capped one read past 12000; not at 5100 for the first document.
    expect(at).toBeGreaterThanOrEqual(12_000);
    expect(at).toBeLessThan(12_200);
  });

  test("with no baseline document id there is no watcher: no reads, navigate waits for load", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, { origin: undefined });
    const b = onClock(v, fast, clock);
    await expect(clock.settledAt(b.navigate("https://x/hang"), 8000)).rejects.toThrow("still pending at clock");
    expect(evaluated(v, LOAD_STATE)).toBe(0);
  });

  test("a read that does not answer queues no second read behind it", async () => {
    const clock = manualClock();
    let release!: (x: unknown) => void;
    let first = true;
    const { v } = hangingLoad(clock, {
      read: (expr) => {
        if (expr !== LOAD_STATE || !first) return undefined;
        first = false;
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const b = onClock(v, fast, clock);
    await expect(clock.settledAt(b.navigate("https://x/hang"), 3000)).rejects.toThrow("still pending at clock");
    // Freed later: one read follows it, not the dozens a 100 ms timer would have queued.
    release([1, "complete"]);
    await new Promise((r) => setImmediate(r));
    expect(evaluated(v, LOAD_STATE)).toBeLessThanOrEqual(2);
  });

  // CI runs 40415723808 and 40834466493: a new view's first evaluate took past graceMs, then past 1 s.
  test("a baseline read that takes 1.5 s still starts the watcher", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, {
      read: (expr) =>
        expr === DOC_ID
          ? new Promise((r) => {
              clock.setTimeout(() => r(1), 1500);
            })
          : undefined,
    });
    const b = onClock(v, fast, clock);
    expect(await clock.fulfilledAt(b.navigate("https://x/hang"), 10_000)).toBeLessThan(8000);
  });

  // #48 in CI run 40415723808: WebKit refuses a direct evaluate while another
  // is pending, so a recovery during a read lost LEAVE_INITIAL_DOCUMENT.
  test("a recovery waits for the watcher's read before it leaves the initial document", async () => {
    const clock = manualClock();
    let pending = 0;
    let readDone!: () => void;
    const { v } = hangingLoad(clock, {
      state: "loading",
      read: (expr) => {
        if (expr === LEAVE_INITIAL_DOCUMENT) {
          if (pending > 0) return Promise.reject(new Error("an evaluate is already pending"));
          return Promise.resolve(undefined);
        }
        if (expr !== LOAD_STATE || pending > 0) return undefined;
        pending++;
        return new Promise((r) => {
          readDone = () => {
            pending--;
            r([1, "complete"]);
          };
          clock.setTimeout(readDone, 400);
        });
      },
    });
    v.url = "";
    const b = onClock(v, fast, clock);
    void b.navigate("https://x/never");
    await new Promise((r) => setImmediate(r));
    await clock.settledAt(b.interrupt());
    expect(v.calls.filter(([n, a]) => (n === "evaluate" && a[0] === LEAVE_INITIAL_DOCUMENT) || (n === "navigate" && a[0] === "about:blank"))).toEqual([
      ["evaluate", [LEAVE_INITIAL_DOCUMENT]],
    ]);
  });

  // Greptile on #214: a watcher ended by a recovery won the race, and navigate
  // returned with go() pending.
  test("a recovery that ends the watcher leaves navigate pending", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, { state: "loading" });
    const b = onClock(v, fast, clock);
    let settled = false;
    void b.navigate("https://x/hang").then(
      () => (settled = true),
      () => (settled = true),
    );
    await clock.settledAt(new Promise((r) => clock.setTimeout(() => r(undefined), 1000)));
    await clock.settledAt(b.interrupt());
    await clock.settledAt(new Promise((r) => clock.setTimeout(() => r(undefined), 3000)));
    expect(settled).toBe(false);
  });

  // Greptile on #214: go() rejected with the replaced navigation's -999
  // (#116) ended the watcher, and the new page's hanging image held goto.
  test("a goto that replaces a navigation in flight still has its load capped", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock);
    const load = v.navigate;
    v.navigate = (url) => {
      load(url).catch(() => {});
      const err = new Error(CANCELLED);
      v.onNavigationFailed?.(err);
      return Promise.reject(err);
    };
    const b = onClock(v, fast, clock);
    const at = await clock.fulfilledAt(b.navigate("https://x/hang"), 10_000);
    expect(at).toBeGreaterThanOrEqual(5100);
    expect(at).toBeLessThan(5300);
  });

  // Greptile on #214: the baseline read can outlast a short budget.
  test("a navigation whose request timed out during the baseline read is never sent", async () => {
    const clock = manualClock();
    const { v } = hangingLoad(clock, {
      read: (expr) =>
        expr === DOC_ID
          ? new Promise((r) => {
              clock.setTimeout(() => r(1), 300);
            })
          : undefined,
    });
    const b = onClock(v, fast, clock);
    clock.setTimeout(() => b.cancelAction?.(), 200);
    await expect(clock.fulfilledAt(b.navigate("https://x/late"))).rejects.toThrow("request timed out before the navigation was sent");
    expect(v.calls.filter(([n]) => n === "navigate")).toEqual([]);
  });
});
