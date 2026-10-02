// createHandler() against a fake Browser: every op reaches the right Browser
// method with the right arguments, and errors come back as { ok: false }.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import type { Browser } from "../src/browser.ts";
import { createHandler, dispatch, type DaemonState, type StuckMark } from "../src/daemon/server.ts";
import { IS_URGENT, type DaemonRequest, type DaemonResponse, type DialogReport } from "../src/daemon/protocol.ts";
import { createGate } from "../src/daemon/gate.ts";
import { createSerializer } from "../src/serialize.ts";
import { waitFor } from "./helpers/daemons.ts";

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
    select: rec("select", true),
    setChecked: rec("setChecked", true),
    screenshot: rec("screenshot", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")),
    resize: rec("resize", undefined),
    back: rec("back", undefined),
    forward: rec("forward", undefined),
    reload: rec("reload", undefined),
    close: rec("close", undefined),
    interrupt: rec("interrupt", true),
    watchNavigation: () => {},
    kickerOpened: false,
    navigationPending: false,
    navigationDestination: async () => "https://x/",
    phase: "idle",
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
  test("ping answers the package version without touching the browser", async () => {
    const b = fakeBrowser();
    expect(await createHandler(b)(req("ping"))).toEqual({ id: 7, ok: true, result: pkg.version });
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

  // Spec F34: after its web process died twice, WebKit fails every page op
  // with this message; the reply names the crash and the way out.
  test("the engine's dead-page message becomes the crash message; other errors pass through", async () => {
    const dead = async () => { throw new Error("JavaScript execution returned a result of an unsupported type"); };
    const crashed = "the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'";
    const b = fakeBrowser({ evaluate: dead, click: dead });
    expect(await createHandler(b)(req("evaluate", ["1+1"]))).toEqual({ id: 7, ok: false, error: crashed });
    expect(await createHandler(b)(req("click", ["#a"]))).toEqual({ id: 7, ok: false, error: crashed });
    const other = fakeBrowser({ evaluate: async () => { throw new Error("TypeError: x is not a function"); } });
    expect(await createHandler(other)(req("evaluate", ["x()"]))).toEqual({ id: 7, ok: false, error: "TypeError: x is not a function" });
  });

  // The measured behaviour (spec F34, measured manually): a dead page fails
  // every page op until `reload`, which brings it back. The daemon reloads
  // nothing by itself, and after the reload ops answer again.
  test("a crashed page keeps failing, is not reloaded by the daemon, and works after reload", async () => {
    const crashed = "the page crashed (its web process exited); run 'bowser reload' or 'bowser goto <url>'";
    let dead = true;
    const b = fakeBrowser({
      evaluate: async () => {
        if (dead) throw new Error("JavaScript execution returned a result of an unsupported type");
        // The shim's answer crosses as JSON text (#76).
        return JSON.stringify({ value: 2, dialogs: [] });
      },
      reload: async () => { b.calls.push(["reload", []]); dead = false; },
    });
    const h = createHandler(b);
    expect(await h(req("evaluate", ["1+1"]))).toEqual({ id: 7, ok: false, error: crashed });
    expect(await h(req("evaluate", ["1+1"]))).toEqual({ id: 7, ok: false, error: crashed });
    expect(b.calls.filter(([n]) => n === "reload")).toEqual([]);
    expect(await h(req("reload"))).toEqual({ id: 7, ok: true });
    expect(await h(req("evaluate", ["1+1"]))).toEqual({ id: 7, ok: true, result: 2 });
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
    { id: 1, ok: false, error: "'click' timed out after 5ms" },
  ]);
});

test("a timeout while awaiting navigation says the click was delivered", async () => {
  const b = fakeBrowser({ phase: "awaiting-navigation", click: () => new Promise<void>(() => {}) });
  const replies: DaemonResponse[] = [];
  const lane = { handle: createHandler(b), serialize: createSerializer(), timeoutMs: 20, phase: () => b.phase, reply: (r: DaemonResponse) => { replies.push(r); } };
  dispatch({ id: 1, op: "click", args: ["#go"], cmd: "click" }, lane);
  dispatch({ id: 2, op: "click", args: ["#go"], cmd: "fill" }, { ...lane, serialize: createSerializer() });
  await Bun.sleep(60);
  expect(replies).toEqual([
    { id: 1, ok: false, error: "'click' timed out after 20ms waiting for the page it opened; the click was delivered, check the page before retrying" },
    { id: 2, ok: false, error: "'fill' timed out after 20ms waiting for the page its click opened; the click was delivered but the fill did not finish, check the page before retrying" },
  ]);
});

test("a timeout while acting keeps the plain timeout message", async () => {
  const b = fakeBrowser({ phase: "acting", click: () => new Promise<void>(() => {}) });
  const replies: DaemonResponse[] = [];
  dispatch({ id: 1, op: "click", args: ["#go"] }, { handle: createHandler(b), serialize: createSerializer(), timeoutMs: 20, phase: () => b.phase, reply: (r) => { replies.push(r); } });
  await Bun.sleep(60);
  expect(replies).toEqual([{ id: 1, ok: false, error: "'click' timed out after 20ms" }]);
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
    id: 1, ok: false, error: "'click' timed out after 20ms",
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
  expect(replies).toEqual([{ id: 1, ok: false, error: "'click' timed out after 20ms" }]);
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
    `'${op}' timed out after ${ms}ms (waiting for '${prev}', which timed out and is still running; run 'bowser close' if the session stays stuck)`;

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
      timeoutMs: 400,
      reply: (res: DaemonResponse) => { replies.push([Date.now() - t0, res]); },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    await Bun.sleep(50);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(900);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 1, ok: false, error: "'click' timed out after 400ms" },
      { id: 2, ok: false, error: QUEUED("evaluate", 400, "click") },
    ]);
    // Its deadline counts from receipt (50 ms), so it answers near 450 ms;
    // timed from when the first op timed out (400 ms), it would answer near
    // 800. The threshold sits between them.
    expect(replies[1]![0]).toBeLessThan(625);
    release();
    await Bun.sleep(20);
    // Its client was already told it failed, so it is dropped, not run late.
    expect(ran).toEqual([1]);
  });

  test("F21: a queued step names its command and keeps the waiting tail", async () => {
    const replies: DaemonResponse[] = [];
    const lane = {
      handle: () => new Promise<DaemonResponse>(() => {}), // never settles
      serialize: createSerializer(),
      timeoutMs: 30,
      reply: (res: DaemonResponse) => { replies.push(res); },
    };
    dispatch({ id: 1, op: "click", args: ["#x"], cmd: "click" }, lane);
    dispatch({ id: 2, op: "evaluate", args: ["1"], cmd: "snapshot" }, lane);
    await Bun.sleep(80);
    expect(replies).toEqual([
      { id: 1, ok: false, error: "'click' timed out after 30ms" },
      {
        id: 2, ok: false,
        error: "'snapshot' timed out after 30ms (in its 'evaluate' step) (waiting for 'click', which timed out and is still running; run 'bowser close' if the session stays stuck)",
      },
    ]);
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

  test("a request that reaches the head of the queue with too little budget left times out running, with the plain message", async () => {
    // Its budget counts from receipt, so it may start with a sliver left and
    // overrun it while running. It was not queued at its deadline, so it
    // gets no "waiting for" tail (seen on CI, run 36299769857).
    const replies: Array<[number, DaemonResponse]> = [];
    const BUDGET = 1000, RUN = 600;
    const t0 = Date.now();
    const lane = {
      handle: async (req: DaemonRequest) => {
        await Bun.sleep(RUN);
        return { id: req.id, ok: true as const };
      },
      serialize: createSerializer(),
      timeoutMs: BUDGET,
      reply: (res: DaemonResponse) => { replies.push([Date.now() - t0, res]); },
    };
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane);
    dispatch({ id: 2, op: "evaluate", args: ["location.href"] }, lane);
    await waitFor(() => replies.length >= 2, 3 * BUDGET);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false, error: `'evaluate' timed out after ${BUDGET}ms` },
    ]);
    // Still bounded by its budget from receipt (BUDGET), not from its start
    // (RUN + BUDGET).
    expect(replies[1]![0]).toBeLessThan(BUDGET + RUN / 2);
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
        return new Promise<boolean>((r) => { recovered = () => { events.push("recovered"); r(true); }; });
      },
    };
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane);
    // Timed out at 20 ms, still stuck when the grace (the 20 ms budget,
    // under RECOVERY_GRACE_MS) ends at 40: the recovery runs.
    await Bun.sleep(60);
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

  test("an op that settles within the grace after its timeout is not recovered, and the next op does not wait out the grace", async () => {
    let recoveries = 0;
    const replies: Array<[number, DaemonResponse]> = [];
    const t0 = Date.now();
    const lane = {
      handle: async (req: DaemonRequest) => {
        // Slow, not stuck: overruns its 100 ms budget by 20 ms.
        if (req.id === 1) await Bun.sleep(120);
        return { id: req.id, ok: true as const };
      },
      serialize: createSerializer(),
      timeoutMs: 100,
      reply: (res: DaemonResponse) => { replies.push([Date.now() - t0, res]); },
      recover: async () => { recoveries++; return false; },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    await Bun.sleep(110); // after the first op timed out, with a budget to spare
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane);
    await Bun.sleep(200);
    expect(recoveries).toBe(0);
    expect(replies.map(([, r]) => r.ok)).toEqual([false, true]);
    // Answered once the first op settled (~120 ms), not after the grace (200).
    expect(replies[1]![0]).toBeLessThan(190);
  });

  test("an op still stuck when the grace ends is recovered once", async () => {
    let recoveries = 0;
    const lane = {
      handle: () => new Promise<DaemonResponse>(() => {}),
      serialize: createSerializer(),
      timeoutMs: 30,
      reply: () => {},
      recover: async () => { recoveries++; return false; },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    await Bun.sleep(45);
    expect(recoveries).toBe(0); // timed out at 30, grace until 60
    await Bun.sleep(60);
    expect(recoveries).toBe(1);
    await Bun.sleep(60);
    expect(recoveries).toBe(1);
  });

  test("a request that fails in the queue triggers no recovery: only the running op is interrupted", async () => {
    let recoveries = 0;
    const lane = {
      handle: () => new Promise<DaemonResponse>(() => {}),
      serialize: createSerializer(),
      timeoutMs: 10,
      reply: () => {},
      recover: async () => { recoveries++; return false; },
    };
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane);
    dispatch({ id: 2, op: "click", args: ["#y"] }, lane);
    dispatch({ id: 3, op: "click", args: ["#z"] }, lane);
    await Bun.sleep(40);
    expect(recoveries).toBe(1);
  });
});

// #77: requests of different connections on one session run one connection
// at a time, through the gate, before the serializer.
describe("the session gate", () => {
  const WAITING = (op: string, ms: number) =>
    `'${op}' timed out after ${ms}ms (waiting for another client's command on this session)`;

  function lanes(handle: (req: DaemonRequest) => Promise<DaemonResponse>, timeoutMs: number, idleMs = timeoutMs) {
    const gate = createGate(idleMs);
    const serialize = createSerializer();
    const replies: DaemonResponse[] = [];
    const lane = (conn: object, ms = timeoutMs) =>
      ({ handle, serialize, gate, conn, timeoutMs: ms, reply: (r: DaemonResponse) => { replies.push(r); } });
    return { gate, lane, replies };
  }

  test("requests of a second connection wait until the first connection closes", async () => {
    const started: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const { gate, lane, replies } = lanes(async (req) => {
      started.push(req.id);
      if (req.id === 1) await slow;
      return { id: req.id, ok: true as const };
    }, 0);
    const A = {}, B = {};
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane(A));
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane(B));
    dispatch({ id: 3, op: "evaluate", args: ["3"] }, lane(A));
    await Bun.sleep(10);
    release();
    await Bun.sleep(10);
    expect(started).toEqual([1, 3]);
    gate.leave(A);
    await Bun.sleep(10);
    expect(started).toEqual([1, 3, 2]);
    expect(replies.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  test("urgent ops skip the gate", async () => {
    const { lane, replies } = lanes(async (req) => {
      if (req.op !== "ping") await new Promise(() => {});
      return { id: req.id, ok: true as const, result: req.op };
    }, 0);
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane({}));
    dispatch({ id: 2, op: "ping", args: [] }, lane({}));
    await Bun.sleep(10);
    expect(replies).toEqual([{ id: 2, ok: true, result: "ping" }]);
  });

  test("a request that times out at the gate says so", async () => {
    const { lane, replies } = lanes(() => new Promise<DaemonResponse>(() => {}), 50);
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane({}));
    await Bun.sleep(5);
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane({}));
    await Bun.sleep(80);
    expect(replies).toEqual([
      { id: 1, ok: false, error: "'evaluate' timed out after 50ms" },
      { id: 2, ok: false, error: WAITING("evaluate", 50) },
    ]);
  });

  test("a closed holder whose op timed out passes the gate on, and the next op still waits for that op at the serializer", async () => {
    const started: number[] = [];
    let release!: () => void;
    const stuck = new Promise<void>((r) => { release = r; });
    const { gate, lane, replies } = lanes(async (req) => {
      started.push(req.id);
      if (req.id === 1) await stuck;
      return { id: req.id, ok: true as const };
    }, 20, 0);
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane(A));
    await Bun.sleep(30);
    gate.leave(A);
    const B = {};
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane(B, 30));
    dispatch({ id: 3, op: "evaluate", args: ["3"] }, lane(B, 0));
    await Bun.sleep(50);
    expect(replies).toEqual([
      { id: 1, ok: false, error: "'evaluate' timed out after 20ms" },
      { id: 2, ok: false, error: "'evaluate' timed out after 30ms (waiting for 'evaluate', which timed out and is still running; run 'bowser close' if the session stays stuck)" },
    ]);
    expect(started).toEqual([1]);
    release();
    await Bun.sleep(10);
    expect(started).toEqual([1, 3]);
  });

  test("a holder that closes with a later request still queued at the serializer passes the gate on only after it settles", async () => {
    const started: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const { gate, lane } = lanes(async (req) => {
      started.push(req.id);
      if (req.id === 1) await slow;
      if (req.id === 2) await Bun.sleep(20);
      return { id: req.id, ok: true as const };
    }, 0);
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane(A));
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane(A));
    dispatch({ id: 3, op: "evaluate", args: ["3"] }, lane({}));
    await Bun.sleep(5);
    gate.leave(A);
    release();
    await Bun.sleep(10);
    expect(started).toEqual([1, 2]);
    await Bun.sleep(30);
    expect(started).toEqual([1, 2, 3]);
  });

  test("a request that timed out at the gate does not hold it once its turn comes", async () => {
    const started: number[] = [];
    let hold!: () => void;
    const held = new Promise<void>((r) => { hold = r; });
    const { gate, lane } = lanes(async (req) => {
      started.push(req.id);
      if (req.id === 1) await held;
      return { id: req.id, ok: true as const };
    }, 0, 30);
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane(A));
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane({}, 20));
    dispatch({ id: 3, op: "evaluate", args: ["3"] }, lane({}));
    await Bun.sleep(40);
    hold();
    gate.leave(A);
    // B's connection stays open; its turn passes after the idle time, not never.
    await Bun.sleep(80);
    expect(started).toEqual([1, 3]);
  });

  test("a waiting connection that closes is never run and never answered", async () => {
    const started: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const { gate, lane, replies } = lanes(async (req) => {
      started.push(req.id);
      if (req.id === 1) await slow;
      return { id: req.id, ok: true as const };
    }, 50, 0);
    const A = {}, B = {};
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane(A, 0));
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane(B));
    await Bun.sleep(5);
    gate.leave(B);
    release();
    gate.leave(A);
    await Bun.sleep(80);
    expect(started).toEqual([1]);
    expect(replies.map((r) => r.id)).toEqual([1]);
  });
});

// #78: an op still running after its recovery marks the session stuck, and
// every non-urgent request is answered at once until that op settles.
describe("a stuck session", () => {
  const STUCK = (op: string) => `session is stuck: '${op}' is still running after a reload; run 'bowser close'`;

  function stuckLanes(recover: () => Promise<boolean>, idleMs = 20) {
    const gate = createGate(idleMs);
    const serialize = createSerializer();
    const mark: StuckMark = {};
    const replies: Array<[number, DaemonResponse]> = [];
    const started: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const t0 = Date.now();
    const handle = async (req: DaemonRequest): Promise<DaemonResponse> => {
      started.push(req.id);
      if (req.id === 1) await held;
      return { id: req.id, ok: true, result: req.op };
    };
    const lane = (conn: object, ms = 20) => ({
      handle, serialize, gate, conn, mark, timeoutMs: ms, recover,
      reply: (r: DaemonResponse) => { replies.push([Date.now() - t0, r]); },
    });
    return { lane, replies, started, release, mark, t0 };
  }

  // Timed out at 20 ms, recovered after a 20 ms grace: stuck from ~40 ms.
  test("a request after an unrecovered timeout is answered stuck at once, naming the command", async () => {
    const { lane, replies, started, t0 } = stuckLanes(async () => false);
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"], cmd: "eval" }, lane({}));
    await Bun.sleep(60);
    const sent = Date.now() - t0;
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane({}, 1000));
    await Bun.sleep(50);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 1, ok: false, error: "'eval' timed out after 20ms (in its 'evaluate' step)" },
      { id: 2, ok: false, error: STUCK("eval") },
    ]);
    expect(replies[1]![0] - sent).toBeLessThan(50);
    expect(started).toEqual([1]);
  });

  test("recovery that reports the view free still leaves the session stuck while the op runs", async () => {
    const { lane, replies } = stuckLanes(async () => true);
    dispatch({ id: 1, op: "click", args: ["#x"] }, lane({}));
    await Bun.sleep(60);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane({}, 1000));
    await Bun.sleep(10);
    expect(replies[1]?.[1]).toEqual({ id: 2, ok: false, error: STUCK("click") });
  });

  test("an op that settles during its recovery leaves no mark", async () => {
    let lane!: ReturnType<typeof stuckLanes>["lane"];
    let release!: () => void;
    const s = stuckLanes(async () => { release(); await Bun.sleep(5); return false; });
    ({ lane, release } = s);
    dispatch({ id: 1, op: "evaluate", args: ["1"] }, lane({}));
    await Bun.sleep(60);
    dispatch({ id: 2, op: "evaluate", args: ["2"] }, lane({}, 1000));
    await Bun.sleep(10);
    expect(s.mark.stuck).toBeUndefined();
    expect(s.replies[1]?.[1]).toEqual({ id: 2, ok: true, result: "evaluate" });
  });

  test("ping is not affected while stuck", async () => {
    const { lane, replies } = stuckLanes(async () => false);
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane({}));
    await Bun.sleep(60);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane({}, 1000));
    dispatch({ id: 3, op: "ping", args: [] }, lane({}, 1000));
    await Bun.sleep(10);
    expect(replies.map(([, r]) => r).slice(1)).toEqual([
      { id: 2, ok: false, error: STUCK("evaluate") },
      { id: 3, ok: true, result: "ping" },
    ]);
  });

  test("the mark clears when the stuck op settles, after which the next request runs", async () => {
    const { lane, replies, release } = stuckLanes(async () => false);
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane({}));
    await Bun.sleep(60);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane({}, 1000));
    release();
    await Bun.sleep(5);
    dispatch({ id: 3, op: "evaluate", args: ["2"] }, lane({}, 1000));
    await Bun.sleep(10);
    expect(replies.map(([, r]) => r).slice(1)).toEqual([
      { id: 2, ok: false, error: STUCK("evaluate") },
      { id: 3, ok: true, result: "evaluate" },
    ]);
  });

  test("requests already queued when the mark is set are answered stuck at once", async () => {
    const { lane, replies, started, release } = stuckLanes(async () => false, 60_000);
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane(A));
    await Bun.sleep(5);
    // Before the mark (~40 ms): one queued at the serializer behind op 1, one
    // at the gate behind connection A, which holds it for its 60 s idle time,
    // so only the mark can answer op 3 before its own 1 s budget does.
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane(A, 1000));
    dispatch({ id: 3, op: "evaluate", args: ["2"] }, lane({}, 1000));
    await waitFor(() => replies.length >= 3, 3000);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 1, ok: false, error: "'evaluate' timed out after 20ms" },
      { id: 2, ok: false, error: STUCK("evaluate") },
      { id: 3, ok: false, error: STUCK("evaluate") },
    ]);
    release();
    await Bun.sleep(80);
    expect(started).toEqual([1]);
    expect(replies).toHaveLength(3);
  });

  test("a stuck answer removes its waiter from a gate that does not idle-release", async () => {
    const { lane, replies, release } = stuckLanes(async () => false, 0);
    const A = {};
    const B = {};
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane(A));
    await Bun.sleep(5);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane(B, 1000));
    await Bun.sleep(60);
    expect(replies[1]?.[1].error).toBe(STUCK("evaluate"));

    // Release A as though its socket closed. A stale B waiter would become
    // the permanent gate holder when idle-release is disabled.
    lane(A).gate.leave(A);
    release();
    await Bun.sleep(5);
    dispatch({ id: 3, op: "evaluate", args: ["2"] }, lane({}));
    await Bun.sleep(10);
    expect(replies[2]?.[1]).toEqual({ id: 3, ok: true, result: "evaluate" });
  });

  test("a second timed-out op while stuck does not recover twice", async () => {
    let recoveries = 0;
    const { lane } = stuckLanes(async () => { recoveries++; return false; });
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane(A));
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane(A));
    await Bun.sleep(60);
    dispatch({ id: 3, op: "evaluate", args: ["2"] }, lane(A));
    dispatch({ id: 4, op: "evaluate", args: ["3"] }, lane({}));
    await Bun.sleep(100);
    expect(recoveries).toBe(1);
  });

  test("with budgets off no mark is ever set", async () => {
    let recoveries = 0;
    const { lane, replies, mark } = stuckLanes(async () => { recoveries++; return false; });
    const A = {};
    dispatch({ id: 1, op: "evaluate", args: ["new Promise(() => {})"] }, lane(A, 0));
    await Bun.sleep(60);
    dispatch({ id: 2, op: "evaluate", args: ["1"] }, lane(A, 0));
    await Bun.sleep(20);
    expect(recoveries).toBe(0);
    expect(mark.stuck).toBeUndefined();
    expect(replies).toEqual([]);
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
      // Bound, so Function.prototype.toString says [native code], as it
      // does for the engine's own functions.
      alert: (() => undefined).bind(null), confirm: (() => false).bind(null), prompt: (() => null).bind(null),
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
  /** Add a child frame to the current document: a same-origin one the page
   *  can reach, or a cross-origin one whose every property read throws. */
  const addFrame = (crossOrigin = false) => {
    const f = crossOrigin
      ? new Proxy({}, { get: () => { throw new Error("SecurityError: cross-origin"); } }) as typeof win
      : engine();
    const n = (win.length as number | undefined) ?? 0;
    win[n] = f;
    win.length = n + 1;
    return f;
  };
  /** A call a frame's own code makes on its window. */
  const inFrame = <T>(f: typeof win, name: "alert" | "confirm" | "prompt", ...a: unknown[]) => (f[name] as (...a: unknown[]) => T)(...a);
  return Object.assign(b, { load, page, window, restore, addFrame, inFrame });
}

// #76: Bun.WebView serializes the page's answer with the page's own JSON, so
// a Prototype.js-style Array.prototype.toJSON turned every array in it into
// "proto". webkitBrowser runs the scripts in this realm, so the patch goes on
// this realm's Array.prototype for the length of each call.
describe("a page's Array.prototype.toJSON (#76)", () => {
  const patched = async <T>(fn: () => Promise<T>): Promise<T> => {
    const proto = Array.prototype as { toJSON?: () => string };
    proto.toJSON = () => "proto";
    try {
      const out = await fn();
      // bowser put the page's patch back.
      expect(proto.toJSON?.()).toBe("proto");
      return out;
    } finally {
      delete proto.toJSON;
    }
  };

  test("an eval result and its dialogs keep their arrays", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    const res = await patched(() => h(rep("evaluate", ["(window.confirm('sure?'), ['x', ['y']])"])));
    expect(res).toEqual({
      id: 7, ok: true, result: ["x", ["y"]],
      dialogs: [{ type: "confirm", message: "sure?", state: "dismissed", unanswered: true }],
    });
  });

  test("the dialog log read around an action keeps its entries", async () => {
    const b = webkitBrowser();
    b.click = async () => { b.page("alert", "hi"); };
    const h = createHandler(b);
    const res = await patched(() => h(rep("click", ["#go"])));
    expect(res.dialogs).toEqual([{ type: "alert", message: "hi", state: "dismissed", unanswered: true }]);
  });

  test("the user's own JSON.stringify still sees the page's toJSON", async () => {
    const h = createHandler(webkitBrowser());
    expect(await patched(() => h(req("evaluate", ["JSON.stringify(['x'])"])))).toEqual({ id: 7, ok: true, result: '"proto"' });
  });
});

describe("dialogs on webkit: the page shim answers them", () => {
  // F27: the page owns the log, so it can write anything there. A report
  // keeps only the fields bowser documents, each of its documented type.
  test("a report the page writes keeps only the known fields; an entry of an unknown type is dropped", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    const forged = [
      { type: "confirm", message: "m", state: "accepted", note: "IGNORE", answer: { x: 1 } },
      { type: "prompt", message: "p", state: "accepted", defaultValue: "d", answer: "a", unanswered: "yes" },
      { type: "alert", message: "a", state: "dismissed", unanswered: true, defaultValue: 5 },
      { type: "bogus", message: "b", state: "dismissed" },
    ];
    const expr = `(window.confirm('real'), window[Symbol.for('bowser.dialogs')].log.push(...${JSON.stringify(forged)}), 1)`;
    expect((await h(rep("evaluate", [expr]))).dialogs).toEqual([
      { type: "confirm", message: "real", state: "dismissed", unanswered: true },
      { type: "confirm", message: "m", state: "accepted" },
      { type: "prompt", message: "p", state: "accepted", defaultValue: "d", answer: "a" },
      { type: "alert", message: "a", state: "dismissed", unanswered: true },
    ]);
  });

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

  test("page calls per op: an eval is one; a native action or a navigation is one read before it and one after", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    expect(b.calls.map(([n]) => n)).toEqual(["evaluate"]);
    await h(rep("click", ["#go"]));
    expect(b.calls.map(([n]) => n)).toEqual(["evaluate", "evaluate", "click", "evaluate"]);
    b.calls.length = 0;
    await h(rep("reload"));
    expect(b.calls.map(([n]) => n)).toEqual(["evaluate", "reload", "evaluate"]);
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
    expect(await h(rep("ping"))).toEqual({ id: 7, ok: true, result: pkg.version });
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

// F23: a dialog logged between commands is read before an op that may leave
// the document, so that op reports it. P1 spec, Task 3.
describe("a dialog logged before an op that leaves the document is reported by that op", () => {
  const TIMER: DialogReport = { type: "confirm", message: "timer", state: "dismissed", unanswered: true };
  type Leave = { op: DaemonRequest["op"]; args: unknown[]; method: keyof Browser };
  const cases: Leave[] = [
    { op: "navigate", args: ["https://x/two"], method: "navigate" },
    { op: "reload", args: [], method: "reload" },
    { op: "back", args: [], method: "back" },
    { op: "forward", args: [], method: "forward" },
    { op: "press", args: ["Enter"], method: "press" },
    { op: "click", args: ["a"], method: "click" },
    { op: "type", args: ["x"], method: "type" },
    { op: "hover", args: ["a"], method: "hover" },
    { op: "select", args: ["#s", "b"], method: "select" },
    { op: "check", args: ["#c"], method: "setChecked" },
    { op: "uncheck", args: ["#c"], method: "setChecked" },
  ];
  for (const { op, args, method } of cases) {
    test(`${op}`, async () => {
      const b = webkitBrowser();
      const h = createHandler(b);
      await h(rep("evaluate", ["1"]));
      b.page("confirm", "timer"); // a timer, between commands
      (b as unknown as Record<string, unknown>)[method] = async () => { b.load(); return true; };
      expect((await h(rep(op, args))).dialogs).toEqual([TIMER]);
    });
  }

  test("a report read before the page left does not come back when back restores it from the cache", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    b.page("confirm", "timer");
    const first = b.window();
    b.press = async () => { b.load(); }; // Enter submits the form
    expect((await h(rep("press", ["Enter"]))).dialogs).toEqual([TIMER]);
    b.back = async () => { b.restore(first); };
    expect((await h(rep("back"))).dialogs).toBeUndefined();
    expect((await h(rep("evaluate", ["1"]))).dialogs).toBeUndefined();
  });

  test("a page that cannot evaluate reports nothing, and the navigation still runs", async () => {
    const b = fakeBrowser({ evaluate: async () => { throw new Error("busy"); } });
    const h = createHandler(b);
    expect(await h(rep("reload"))).toEqual({ id: 7, ok: true });
    expect(actions(b).map(([n]) => n)).toEqual(["reload"]);
  });
});

// F24: the shim replaces only the engine's own alert/confirm/prompt.
describe("a page's own alert, confirm or prompt is left alone", () => {
  test("a page-defined confirm runs and nothing is reported", async () => {
    const b = webkitBrowser();
    b.window().confirm = (m: string) => "custom:" + m;
    const h = createHandler(b);
    expect(await h(rep("evaluate", ["window.confirm('really')"]))).toEqual({ id: 7, ok: true, result: "custom:really" });
  });

  test("the ones the page did not define are still shimmed", async () => {
    const b = webkitBrowser();
    b.window().alert = () => "page alert";
    const h = createHandler(b);
    expect(await h(rep("evaluate", ["[window.alert('a'), window.confirm('c')]"]))).toEqual({
      id: 7, ok: true, result: ["page alert", false], dialogs: [{ type: "confirm", message: "c", state: "dismissed", unanswered: true }],
    });
  });
});

// F25: same-origin frames get the shim too, and share the top window's answer.
describe("dialogs in same-origin frames", () => {
  test("a frame's confirm is reported and takes the prepared answer, which is then spent", async () => {
    const b = webkitBrowser();
    const frame = b.addFrame();
    const h = createHandler(b);
    await h(rep("dialog-answer", [true]));
    const got: unknown[] = [];
    b.click = async () => { got.push(b.inFrame(frame, "confirm", "frame")); };
    expect((await h(rep("click", ["#via"]))).dialogs).toEqual([{ type: "confirm", message: "frame", state: "accepted" }]);
    b.click = async () => { got.push(b.page("confirm", "top")); };
    expect((await h(rep("click", ["#top"]))).dialogs).toEqual([{ type: "confirm", message: "top", state: "dismissed", unanswered: true }]);
    expect(got).toEqual([true, false]);
  });

  test("a frame of a frame is reached, and a frame added later gets the shim on the next op", async () => {
    const b = webkitBrowser();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    const child = b.addFrame();
    child[0] = engine2(child);
    await h(rep("evaluate", ["1"]));
    b.inFrame(child[0] as Record<string | symbol, unknown>, "alert", "deep");
    expect((await h(rep("evaluate", ["1"]))).dialogs).toEqual([{ type: "alert", message: "deep", state: "dismissed", unanswered: true }]);

    function engine2(parent: Record<string | symbol, unknown>) {
      parent.length = 1;
      return { alert: (() => undefined).bind(null), confirm: (() => false).bind(null), prompt: (() => null).bind(null) } as Record<string | symbol, unknown>;
    }
  });

  test("a cross-origin frame is skipped, and the frames after it are still shimmed", async () => {
    const b = webkitBrowser();
    b.addFrame(true);
    const same = b.addFrame();
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    b.inFrame(same, "confirm", "after");
    expect((await h(rep("evaluate", ["1"]))).dialogs).toEqual([{ type: "confirm", message: "after", state: "dismissed", unanswered: true }]);
  });

  test("a frame's own confirm is left alone", async () => {
    const b = webkitBrowser();
    const frame = b.addFrame();
    frame.confirm = () => "frame's own";
    const h = createHandler(b);
    await h(rep("evaluate", ["1"]));
    expect(b.inFrame<string>(frame, "confirm", "x")).toBe("frame's own");
    expect((await h(rep("evaluate", ["1"]))).dialogs).toBeUndefined();
  });
});

describe("the command budget (budgetMs)", () => {
  const lane = (replies: Array<[number, DaemonResponse]>, t0: number, timeoutMs = 1000) => ({
    handle: () => new Promise<DaemonResponse>(() => {}), // never settles
    serialize: createSerializer(),
    timeoutMs,
    reply: (res: DaemonResponse) => { replies.push([Date.now() - t0, res]); },
  });

  test("a request with budgetMs smaller than the daemon's budget times out at budgetMs", async () => {
    const replies: Array<[number, DaemonResponse]> = [];
    const t0 = Date.now();
    dispatch({ id: 1, op: "type", args: ["hi"], cmd: "fill", budgetMs: 50 }, lane(replies, t0));
    await Bun.sleep(300);
    // The message names the command's budget, not what was left of it.
    expect(replies.map(([, r]) => r)).toEqual([{ id: 1, ok: false, error: "'fill' timed out after 1000ms (in its 'type' step)" }]);
    expect(replies[0]![0]).toBeLessThan(200);
  });

  test("budgetMs <= 0 fails at once with the timeout message", async () => {
    for (const budgetMs of [0, -5]) {
      const replies: Array<[number, DaemonResponse]> = [];
      dispatch({ id: 1, op: "click", args: ["#x"], cmd: "click", budgetMs }, lane(replies, Date.now()));
      expect(replies.map(([, r]) => r)).toEqual([{ id: 1, ok: false, error: "'click' timed out after 1000ms" }]);
    }
  });

  // ET-10 before its fix: a daemon on 30 s and a command on 3 s said "after 30000ms".
  test("the timeout message names the command's own budget (budgetTotalMs)", async () => {
    const replies: Array<[number, DaemonResponse]> = [];
    dispatch({ id: 1, op: "click", args: ["#b"], cmd: "fill", budgetMs: 50, budgetTotalMs: 3000 }, lane(replies, Date.now(), 30_000));
    dispatch({ id: 2, op: "click", args: ["#b"], cmd: "fill", budgetMs: 0, budgetTotalMs: 3000 }, lane(replies, Date.now(), 30_000));
    await Bun.sleep(300);
    expect(replies.map(([, r]) => r)).toEqual([
      { id: 2, ok: false, error: "'fill' timed out after 3000ms (in its 'click' step)" },
      { id: 1, ok: false, error: "'fill' timed out after 3000ms (in its 'click' step)" },
    ]);
  });

  test("budgetMs bounds the request when the daemon's budget is off", async () => {
    const replies: Array<[number, DaemonResponse]> = [];
    const t0 = Date.now();
    dispatch({ id: 1, op: "click", args: ["#x"], budgetMs: 50 }, lane(replies, t0, 0));
    await Bun.sleep(300);
    expect(replies.map(([, r]) => r)).toEqual([{ id: 1, ok: false, error: "'click' timed out after 50ms" }]);
  });
});

describe("an action on a page whose navigation is still pending (ET-10)", () => {
  const stillLoading = "page is still loading https://x/; retry later, or run 'bowser close'";

  test("fails with 'page is still loading' before its own timer, which counts queue time and budgetMs", async () => {
    for (const [timeoutMs, budgetMs] of [[200, undefined], [0, 200], [1000, 200]] as const) {
      const b = fakeBrowser({ navigationPending: true });
      const replies: Array<[number, DaemonResponse]> = [];
      const t0 = Date.now();
      const lane = { handle: createHandler(b), serialize: createSerializer(), timeoutMs, reply: (r: DaemonResponse) => { replies.push([Date.now() - t0, r]); } };
      lane.serialize(() => Bun.sleep(80), "evaluate");
      dispatch({ id: 1, op: "click", args: ["#b"], cmd: "fill", ...(budgetMs ? { budgetMs } : {}) }, lane);
      await Bun.sleep(400);
      expect(replies.map(([, r]) => r)).toEqual([{ id: 1, ok: false, error: stillLoading }]);
      expect(replies[0]![0]).toBeLessThan(200);
      expect(actions(b)).toEqual([]);
    }
  });

  test("with budgets off, it waits until the navigation ends", async () => {
    let pending = true;
    const b = fakeBrowser();
    Object.defineProperty(b, "navigationPending", { get: () => pending });
    const replies: DaemonResponse[] = [];
    dispatch({ id: 1, op: "click", args: ["#b"] }, { handle: createHandler(b), serialize: createSerializer(), timeoutMs: 0, reply: (r) => { replies.push(r); } });
    await Bun.sleep(100);
    expect(replies).toEqual([]);
    pending = false;
    await Bun.sleep(50);
    expect(replies).toEqual([{ id: 1, ok: true }]);
    expect(actions(b)).toEqual([["click", ["#b"]]]);
  });
});
