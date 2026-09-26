// createHandler() against a fake Browser: every op reaches the right Browser
// method with the right arguments, and errors come back as { ok: false }.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "../src/browser.ts";
import { createHandler, dispatch, type DaemonState } from "../src/daemon/server.ts";
import { IS_URGENT, type DaemonRequest, type DaemonResponse } from "../src/daemon/protocol.ts";
import { createSerializer } from "../src/serialize.ts";

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
    interrupt: rec("interrupt", undefined),
    watchNavigation: () => {},
    ...over,
  };
  return b;
}

// The smallest fake that can prove `state` reads url/title live rather than
// from a cache: fakeBrowser()'s realUrl/realTitle are fixed at construction,
// so `state`'s two DaemonState tests need one whose page can move.
function fakeBrowserWithPage(url: string, title: string): Browser & { setPage(url: string, title: string): void } {
  const page = { url, title };
  return {
    ...fakeBrowser({
      realUrl: async () => page.url,
      realTitle: async () => page.title,
    }),
    setPage(url: string, title: string) {
      page.url = url;
      page.title = title;
    },
  };
}

const req = (op: DaemonRequest["op"], args?: unknown[]): DaemonRequest => ({ id: 7, op, args });
const rep = (op: DaemonRequest["op"], args?: unknown[]): DaemonRequest => ({ ...req(op, args), report: true });

/** The browser calls an op made, without the dialog shim's page reads. */
const actions = (b: { calls: Array<[string, unknown[]]> }) => b.calls.filter(([n]) => n !== "evaluate");

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

  test("state reports the page's live url and title, not a cached copy", async () => {
    // Two reads with a navigation between them must differ: this fails if
    // DaemonState ever starts caching url/title.
    const browser = fakeBrowserWithPage("https://a.example/", "A");
    const state: DaemonState = {};
    const handle = createHandler(browser, state);
    const first = await handle({ id: 1, op: "state", args: [] });
    browser.setPage("https://b.example/", "B");
    const second = await handle({ id: 2, op: "state", args: [] });
    expect(first).toMatchObject({ ok: true, result: { url: "https://a.example/" } });
    expect(second).toMatchObject({ ok: true, result: { url: "https://b.example/" } });
  });

  test("state omits dialog entirely when none is open", async () => {
    const handle = createHandler(fakeBrowser(), {});
    const res = await handle({ id: 1, op: "state", args: [] });
    expect(res.ok && "dialog" in (res.result as object)).toBe(false);
  });

  test("state reports the daemon's persistent profile, and none when ephemeral", async () => {
    const persistent = await createHandler(fakeBrowser(), { profile: "/p/dir" })(req("state"));
    expect(persistent).toMatchObject({ ok: true, result: { profile: "/p/dir" } });
    const ephemeral = await createHandler(fakeBrowser(), {})(req("state"));
    expect(ephemeral.ok && "profile" in (ephemeral.result as object)).toBe(false);
  });

  test("navigate, select and resize forward their arguments", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("navigate", ["https://y/"]));
    await h(req("select", ["#s", "blue"]));
    await h(req("resize", [900, 700]));
    expect(actions(b)).toEqual([["navigate", ["https://y/"]], ["select", ["#s", "blue"]], ["resize", [900, 700]]]);
  });

  test("check and uncheck map to setChecked", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("check", ["#c"]));
    await h(req("uncheck", ["#c"]));
    expect(actions(b)).toEqual([["setChecked", ["#c", true]], ["setChecked", ["#c", false]]]);
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

  test("a throwing browser method becomes { ok: false, error }", async () => {
    const b = fakeBrowser({ click: async () => { throw new Error("click: element not found"); } });
    expect(await createHandler(b)(req("click", ["#nope"]))).toEqual({ id: 7, ok: false, error: "click: element not found" });
  });

  test("an unknown op on the wire is rejected, not thrown", async () => {
    const res = await createHandler(fakeBrowser())({ id: 7, op: "dblclick" as DaemonRequest["op"], args: [] });
    expect(res).toEqual({ id: 7, ok: false, error: "unknown op: dblclick" });
  });

  test("shutdown replies before the process exits", async () => {
    // The daemon writes the reply from handle().then(...); the exit must be a
    // macrotask or it runs first and every close hangs (PR 3, Ruling 4).
    const order: string[] = [];
    const realExit = process.exit;
    process.exit = ((code?: number) => { order.push(`exit:${code}`); }) as never;
    const b = fakeBrowser();
    try {
      await createHandler(b)(req("shutdown")).then((res) => { order.push(`reply:${res.ok}`); });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.exit = realExit;
    }
    expect(order).toEqual(["reply:true", "exit:0"]);
    expect(b.calls).toEqual([["close", []]]);
  });

  test("a prototype key is an unknown op, not a lookup hit", async () => {
    const res = await createHandler(fakeBrowser())({ id: 7, op: "toString" as DaemonRequest["op"], args: [] });
    expect(res).toEqual({ id: 7, ok: false, error: "unknown op: toString" });
  });
});

test("ping and shutdown are the urgent ops, and nothing else is", () => {
  expect([...IS_URGENT].sort()).toEqual(["ping", "shutdown"]);
});

test("an urgent op answers while a queued op is wedged", async () => {
  // The regression this guards: route urgent ops through the serializer and
  // `ping` waits for the wedged op, so a stuck daemon can never be shut down.
  const replies: string[] = [];
  let release!: () => void;
  const wedged = new Promise<void>((r) => { release = r; });
  const serialize = createSerializer();
  const lane = {
    handle: async (req: DaemonRequest) => {
      if (req.op !== "ping") await wedged;
      return { id: req.id, ok: true as const, result: req.op };
    },
    serialize,
    timeoutMs: 0,
    reply: (res: DaemonResponse) => { replies.push(String(res.ok && res.result)); },
  };

  dispatch({ id: 1, op: "click", args: ["#x"] } as DaemonRequest, lane);
  dispatch({ id: 2, op: "ping", args: [] } as DaemonRequest, lane);
  await Bun.sleep(20);

  // ping answered; click is still stuck behind its own wedge.
  expect(replies).toEqual(["ping"]);
  release();
  await Bun.sleep(20);
  expect(replies).toEqual(["ping", "click"]);
});

test("a queued op that overruns its budget answers with a timeout error", async () => {
  // Both tests above pass timeoutMs: 0, which makes withTimeout a no-op, so
  // neither reaches the timeout branch. Without this the whole per-op budget
  // could be deleted and the suite would stay green — the final review of
  // PR 6 proved exactly that by deleting it.
  const replies: DaemonResponse[] = [];
  const lane = {
    handle: () => new Promise<DaemonResponse>(() => {}), // never settles
    serialize: createSerializer(),
    timeoutMs: 5,
    reply: (res: DaemonResponse) => { replies.push(res); },
  };
  dispatch({ id: 1, op: "click", args: ["#x"] } as DaemonRequest, lane);
  await Bun.sleep(40);
  expect(replies).toEqual([
    { id: 1, ok: false, error: "operation 'click' timed out after 5ms" },
  ]);
});

test("an op that overruns its budget: the timeout reply carries the reports queued before it, and its own late ones wait for the next printing request", async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const b = webkitBrowser();
  b.click = async () => { await hang; b.page("prompt", "name?", "def"); };
  const handle = createHandler(b);
  // An op that prints nothing reads the page's confirm and leaves it queued.
  await handle(req("evaluate", ["window.confirm('sure?')"]));
  const replies: DaemonResponse[] = [];
  const lane = { handle, serialize: createSerializer(), timeoutMs: 20, reply: (r: DaemonResponse) => { replies.push(r); }, timedOut: handle.timedOut };
  dispatch({ id: 1, op: "click", args: ["#go"], report: true }, lane);
  await Bun.sleep(80);
  expect(replies).toEqual([{
    id: 1, ok: false, error: "operation 'click' timed out after 20ms",
    dialogs: [{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }],
  }]);
  release();
  await Bun.sleep(20);
  // The late op's report was not spent on a reply nobody reads.
  expect((await handle(rep("evaluate", ["1"]))).dialogs).toEqual([
    { type: "prompt", message: "name?", defaultValue: "def", state: "dismissed", unanswered: true },
  ]);
});

test("a timed-out request that prints nothing leaves the queued reports alone", async () => {
  const b = webkitBrowser();
  b.click = async () => { await new Promise(() => {}); };
  const handle = createHandler(b);
  await handle(req("evaluate", ["window.confirm('sure?')"]));
  const replies: DaemonResponse[] = [];
  dispatch({ id: 1, op: "click", args: ["#go"] }, { handle, serialize: createSerializer(), timeoutMs: 20, reply: (r) => { replies.push(r); }, timedOut: handle.timedOut });
  await Bun.sleep(60);
  expect(replies).toEqual([{ id: 1, ok: false, error: "operation 'click' timed out after 20ms" }]);
  expect((await handle(rep("evaluate", ["1"]))).dialogs).toEqual([
    { type: "confirm", message: "sure?", state: "dismissed", unanswered: true },
  ]);
});

test("a non-urgent op waits its turn behind the one before it", async () => {
  // The other half: without the serializer two ops could touch the WebView
  // at once. Proves the urgent lane above is a real exception, not the norm.
  const replies: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((r) => { release = r; });
  const serialize = createSerializer();
  const lane = {
    handle: async (req: DaemonRequest) => {
      if (req.id === 1) await first;
      return { id: req.id, ok: true as const, result: req.op };
    },
    serialize,
    timeoutMs: 0,
    reply: (res: DaemonResponse) => { replies.push(String(res.ok && res.result)); },
  };

  dispatch({ id: 1, op: "click", args: ["#x"] } as DaemonRequest, lane);
  dispatch({ id: 2, op: "type", args: ["hi"] } as DaemonRequest, lane);
  await Bun.sleep(20);
  expect(replies).toEqual([]);
  release();
  await Bun.sleep(20);
  expect(replies).toEqual(["click", "type"]);
});

// F9: a request's budget runs from the moment the daemon receives it, queue
// time included, so one op that never settles cannot hold the requests behind
// it past their own budgets.
describe("the queue-time budget", () => {
  const QUEUED = (op: string, ms: number, prev: string) =>
    `operation '${op}' timed out after ${ms}ms (waiting for '${prev}', which timed out and is still running; run 'bowser close' if the session stays stuck)`;

  test("a request still queued behind a timed-out op fails at its own deadline, and never runs", async () => {
    const replies: Array<[number, DaemonResponse]> = [];
    const ran: number[] = [];
    let release!: () => void;
    const stuck = new Promise<void>((r) => { release = r; });
    const t0 = Date.now();
    const lane = {
      handle: async (req: DaemonRequest) => {
        ran.push(req.id);
        if (req.id === 1) await stuck;
        return { id: req.id, ok: true as const };
      },
      serialize: createSerializer(),
      timeoutMs: 40,
      reply: (res: DaemonResponse) => { replies.push([Date.now() - t0, res]); },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    await Bun.sleep(20);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(100);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 1, ok: false, error: "operation 'click' timed out after 40ms" },
      { id: 2, ok: false, error: QUEUED("evaluate", 40, "click") },
    ]);
    // Its deadline counts from receipt (20 ms), not from when the first op
    // timed out (40 ms): it answers near 60 ms, well before 80.
    expect(replies[1]![0]).toBeLessThan(78);
    release();
    await Bun.sleep(20);
    // Its client was already told it failed, so it is dropped, not run late.
    expect(ran).toEqual([1]);
  });

  test("a request that reaches the head of the queue in time runs, on its remaining budget", async () => {
    const replies: DaemonResponse[] = [];
    const lane = {
      handle: async (req: DaemonRequest) => {
        await Bun.sleep(req.id === 1 ? 30 : 0);
        return { id: req.id, ok: true as const, result: req.op };
      },
      serialize: createSerializer(),
      timeoutMs: 200,
      reply: (res: DaemonResponse) => { replies.push(res); },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(80);
    expect(replies).toEqual([
      { id: 1, ok: true, result: "click" },
      { id: 2, ok: true, result: "evaluate" },
    ]);
  });

  test("ping still answers at once while the queue is wedged past every budget", async () => {
    const replies: DaemonResponse[] = [];
    const lane = {
      handle: async (req: DaemonRequest) => {
        if (req.op !== "ping") await new Promise(() => {});
        return { id: req.id, ok: true as const, result: req.op };
      },
      serialize: createSerializer(),
      timeoutMs: 10,
      reply: (res: DaemonResponse) => { replies.push(res); },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(40);
    dispatch({ id: 3, op: "ping", args: [] }, lane);
    await Bun.sleep(5);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[2]).toEqual({ id: 3, ok: true, result: "ping" });
  });

  test("an op that times out while running tries recovery once, and the queue waits for it", async () => {
    const events: string[] = [];
    let release!: () => void;
    const stuck = new Promise<void>((r) => { release = r; });
    let recovered!: () => void;
    const lane = {
      handle: async (req: DaemonRequest) => {
        events.push(`run ${req.op}`);
        if (req.id === 1) await stuck;
        return { id: req.id, ok: true as const };
      },
      serialize: createSerializer(),
      timeoutMs: 20,
      reply: (res: DaemonResponse) => { events.push(`reply ${res.id} ${res.ok}`); },
      recover: () => {
        events.push("recover");
        return new Promise<void>((r) => { recovered = () => { events.push("recovered"); r(); }; });
      },
    };
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane);
    await Bun.sleep(30);
    // The interrupt frees the stuck op, as reload() does a stuck evaluate.
    release();
    await Bun.sleep(5);
    // Queued now, with a fresh budget: it waits for the recovery to finish,
    // so it never overlaps the reload's navigation.
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(5);
    expect(events).toEqual(["run evaluate", "reply 1 false", "recover"]);
    recovered();
    await Bun.sleep(5);
    expect(events).toEqual(["run evaluate", "reply 1 false", "recover", "recovered", "run evaluate", "reply 2 true"]);
  });

  test("a request that fails in the queue triggers no recovery: only the running op is interrupted", async () => {
    let recoveries = 0;
    const lane = {
      handle: () => new Promise<DaemonResponse>(() => {}),
      serialize: createSerializer(),
      timeoutMs: 10,
      reply: () => {},
      recover: async () => { recoveries++; },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    dispatch({ id: 2, op: "click", args: ["#y"] }, lane);
    dispatch({ id: 3, op: "click", args: ["#z"] }, lane);
    await Bun.sleep(40);
    expect(recoveries).toBe(1);
  });
});

// A WebKit browser: no dialog events, and a page that is a plain object the
// page scripts really run against. Its engine answers a
// dialog no shim catches the way WebKit's does: dismissed, and nobody told.
// `load()` is a new document, as the page navigating itself; `navigate` is one too.
// Leaving a document fires its pagehide listeners. Real WebKit also calls the
// navigation callback (onNavigated, measured on back to a cached page too);
// `callback: false` and `pagehide: false` take those away, to show what
// holds without them.
function webkitBrowser({ callback = true, pagehide = true } = {}) {
  let on: (() => void) | undefined;
  const engine = () => {
    const hide: Array<() => void> = [];
    return {
      alert: () => undefined, confirm: () => false, prompt: () => null,
      addEventListener: (type: string, fn: () => void) => { if (type === "pagehide") hide.push(fn); },
      leave: () => { if (pagehide) hide.forEach((fn) => fn()); },
    } as Record<string | symbol, unknown>;
  };
  let win = engine();
  const b = fakeBrowser({
    watchNavigation: (fn) => { on = fn; },
    // Like Bun.WebView: the expression is awaited and comes back through JSON.
    evaluate: async (expr) => {
      b.calls.push(["evaluate", [expr]]);
      const v = await new Function("window", `return (\n${expr}\n);`)(win);
      const json = JSON.stringify(v);
      return json === undefined ? undefined : JSON.parse(json);
    },
    navigate: async (url) => { b.calls.push(["navigate", [url]]); load(); },
  });
  const go = (next: typeof win) => { (win.leave as () => void)(); win = next; if (callback) on!(); };
  const load = () => go(engine());
  /** The page's own call, as a click handler makes it. */
  const page = <T>(name: "alert" | "confirm" | "prompt", ...a: unknown[]) => (win[name] as (...a: unknown[]) => T)(...a);
  /** The current document, and bringing an earlier one back, as history does. */
  const window = () => win;
  const restore = (w: typeof win) => go(w);
  return Object.assign(b, { load, page, window, restore });
}

describe("dialogs on webkit: the page shim answers them", () => {
  test("a dialog an eval opens is answered in the page and reported by that eval, whose value is unchanged", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    expect(await h(rep("evaluate", ["window.confirm('sure?')"]))).toEqual({
      id: 7, ok: true, result: false, dialogs: [{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }],
    });
    expect(await h(rep("evaluate", ["({ a: [1, 'x'] })"]))).toEqual({ id: 7, ok: true, result: { a: [1, "x"] } });
    expect(await h(rep("evaluate", ["undefined"]))).toEqual({ id: 7, ok: true });
    expect(await h(rep("evaluate", ["Promise.resolve(3)"]))).toEqual({ id: 7, ok: true, result: 3 });
  });

  test("dialog-answer reaches the page before the action: a click's prompt gets the text, once", async () => {
    const b = webkitBrowser();
    const got: unknown[] = [];
    b.click = async () => { got.push(b.page("prompt", "name?", "def")); };
    const h = createHandler(b);
    await h(rep("dialog-answer", [true, "typed"]));
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([
      { type: "prompt", message: "name?", defaultValue: "def", state: "accepted", answer: "typed" },
    ]);
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([
      { type: "prompt", message: "name?", defaultValue: "def", state: "dismissed", unanswered: true },
    ]);
    expect(got).toEqual(["typed", null]);
  });

  test("an accept with no text gives a prompt its default and a confirm true; a dismiss has no hint; the last answer set wins", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    expect(await h(rep("evaluate", ["window.prompt('name?', 'def')"]))).toMatchObject({ result: "def" });
    await h(rep("dialog-answer", [false]));
    await h(rep("dialog-answer", [true]));
    expect(await h(rep("evaluate", ["window.confirm('sure?')"]))).toMatchObject({ result: true });
    await h(rep("dialog-answer", [true]));
    await h(rep("dialog-answer", [false]));
    expect(await h(rep("evaluate", ["[window.prompt('p'), window.alert('a')]"]))).toMatchObject({
      result: [null, null],
      dialogs: [
        { type: "prompt", message: "p", defaultValue: "", state: "dismissed" },
        { type: "alert", message: "a", state: "dismissed", unanswered: true },
      ],
    });
  });

  test("a new document has no shim and so no answer: dialog-answer, then goto, then the confirm is dismissed", async () => {
    const b = webkitBrowser();
    const got: unknown[] = [];
    b.click = async () => { got.push(b.page("confirm", "sure?")); };
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    await h(rep("navigate", ["https://x/next"]));
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }]);
    expect(got).toEqual([false]);
  });

  test("a document restored by back keeps its shim but not its answer: the navigation dropped it", async () => {
    const b = webkitBrowser();
    const got: unknown[] = [];
    b.click = async () => { got.push(b.page("confirm", "sure?")); };
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    const first = b.window();
    await h(rep("navigate", ["https://x/next"]));
    b.back = async () => { b.restore(first); }; // the back-forward cache
    await h(rep("back"));
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }]);
    expect(got).toEqual([false]);
  });

  test("with no navigation callback at all, back to a cached document still has no answer: the navigating op drops it", async () => {
    const b = webkitBrowser({ callback: false, pagehide: false });
    const got: unknown[] = [];
    b.click = async () => { got.push(b.page("confirm", "sure?")); };
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    const first = b.window();
    await h(rep("navigate", ["https://x/next"]));
    b.back = async () => { b.restore(first); };
    await h(rep("back"));
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }]);
    expect(got).toEqual([false]);
  });

  test("with no navigation callback, a click that leaves the page takes the answer with it (pagehide), even if a later click brings it back", async () => {
    const b = webkitBrowser({ callback: false });
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    const first = b.window();
    b.click = async () => { b.load(); }; // a link
    await h(rep("click", ["a"]));
    b.click = async () => { b.restore(first); }; // history.back() in a handler, from the cache
    await h(rep("click", ["#back"]));
    const got: unknown[] = [];
    b.click = async () => { got.push(b.page("confirm", "sure?")); };
    expect((await h(rep("click", ["#go"]))).dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }]);
    expect(got).toEqual([false]);
  });

  test("after the page navigates itself, the shim is installed again before a native action, so its dialog is reported", async () => {
    const b = webkitBrowser();
    b.press = async () => { b.page("alert", "hi"); };
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    b.load(); // a page script navigated, between commands
    expect((await h(rep("press", ["Enter"]))).dialogs).toEqual([{ type: "alert", message: "hi", state: "dismissed", unanswered: true }]);
  });

  test("no extra page call where the op already evaluates: an eval is one call, a click after it is the click and one read", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    await h(rep("click", ["#go"]));
    expect(b.calls.map(([n]) => n)).toEqual(["evaluate", "click", "evaluate"]);
  });

  test("an eval that throws after a dialog keeps its error and reports the dialog with it, and the next op does not replay it", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    expect(await h(rep("evaluate", ["(window.confirm('x'), null.boom)"]))).toMatchObject({
      ok: false, error: expect.stringContaining("null"), dialogs: [{ type: "confirm", message: "x", state: "dismissed", unanswered: true }],
    });
    expect((await h(rep("evaluate", ["1"]))).dialogs).toBeUndefined();
  });

  test("a native action that fails after a dialog reports it with the error", async () => {
    const b = webkitBrowser();
    b.click = async () => { b.page("alert", "hi"); throw new Error("click: gone"); };
    const h = createHandler(b);
    expect(await h(rep("click", ["#go"]))).toMatchObject({
      ok: false, error: "click: gone", dialogs: [{ type: "alert", message: "hi", state: "dismissed", unanswered: true }],
    });
  });

  test("urgent replies carry no dialog reports, and do not consume them", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(req("evaluate", ["window.confirm('sure?')"]));
    expect(await h(rep("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
    expect((await h(rep("evaluate", ["1"]))).dialogs).toHaveLength(1);
  });

  test("a dialog a timer opened is read by the next op but waits for one that prints it", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    b.page("confirm", "later");
    expect(await h(req("evaluate", ["2"]))).toEqual({ id: 7, ok: true, result: 2 });
    expect((await h(rep("evaluate", ["3"]))).dialogs).toEqual([{ type: "confirm", message: "later", state: "dismissed", unanswered: true }]);
  });
});
