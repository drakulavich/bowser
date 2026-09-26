// createHandler() against a fake Browser: every op reaches the right Browser
// method with the right arguments, errors come back as { ok: false }, and
// the cookie ops forward straight to the Browser's cookie methods (the CDP
// method selection they used to do inline now lives in Browser; see
// tests/browser.test.ts for that).
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, DialogListener } from "../src/browser.ts";
import { CDP_UNAVAILABLE } from "../src/browser.ts";
import { createHandler, dispatch, type DaemonState } from "../src/daemon/server.ts";
import { IS_URGENT, type DaemonRequest, type DaemonResponse, type DialogState } from "../src/daemon/protocol.ts";
import { createSerializer } from "../src/serialize.ts";
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
    subscribe: (event) => { calls.push(["subscribe", [event]]); return true; },
    watchDialogs: () => false,
    answerDialog: rec("answerDialog", undefined),
    getCookies: rec("getCookies", [cookie]),
    setCookie: rec("setCookie", { success: true }),
    deleteCookies: rec("deleteCookies", undefined),
    clearCookies: rec("clearCookies", undefined),
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

  test("state carries the dialog when the daemon has one", async () => {
    const state: DaemonState = { dialog: { type: "confirm", message: "sure?" } };
    const handle = createHandler(fakeBrowser(), state);
    const res = await handle({ id: 1, op: "state", args: [] });
    expect(res).toMatchObject({ ok: true, result: { dialog: { type: "confirm", message: "sure?" } } });
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

test("ping, shutdown and dialog-answer are the urgent ops, and nothing else is", () => {
  expect([...IS_URGENT].sort()).toEqual(["dialog-answer", "ping", "shutdown"]);
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

// A browser whose page can open a dialog: the handler's dialog listener is
// captured, so a test fires `opened` exactly when the real page would, from
// inside the op that caused it.
function dialogBrowser(over: Partial<Browser> = {}) {
  let on: DialogListener | undefined;
  const b = fakeBrowser({
    watchDialogs: (l) => { on = l; return true; },
    ...over,
  });
  return Object.assign(b, { on: () => on! });
}

const confirmBox: DialogState = { type: "confirm", message: "sure?" };
const promptBox: DialogState = { type: "prompt", message: "name?", defaultValue: "def" };
const OPEN_ERROR = 'a confirm dialog is open ("sure?"); run dialog-accept or dialog-dismiss';

describe("dialogs", () => {
  test("a click that opens a dialog answers at once with it pending, not when the click settles", async () => {
    const b = dialogBrowser();
    b.click = () => { b.on().opened(confirmBox); return new Promise<void>(() => {}); }; // blocked by the dialog
    const res = await Promise.race([
      createHandler(b)(req("click", ["#go"])),
      Bun.sleep(500).then(() => "still waiting on the page"),
    ]);
    expect(res).toEqual({ id: 7, ok: true, dialogs: [{ ...confirmBox, state: "pending" }] });
  });

  test("while a dialog is pending a page op fails at once with the user error and never reaches the page", async () => {
    const b = dialogBrowser();
    const res = await createHandler(b, { dialog: confirmBox })(req("evaluate", ["1"]));
    expect(res).toEqual({ id: 7, ok: false, error: OPEN_ERROR, dialogs: [{ ...confirmBox, state: "pending" }] });
    expect(b.calls).toEqual([]);
  });

  test("while a dialog is pending, state answers from the view without evaluating in the page", async () => {
    const b = dialogBrowser();
    const res = await createHandler(b, { dialog: confirmBox })(req("state"));
    expect(res).toMatchObject({ ok: true, result: { url: "https://x/", title: "X", dialog: confirmBox } });
    expect(b.calls).toEqual([]);
  });

  test("dialog-answer is urgent, answers the pending dialog and clears it", async () => {
    expect(IS_URGENT.has("dialog-answer")).toBe(true);
    const b = dialogBrowser({ answerDialog: async (...a) => { b.calls.push(["answerDialog", a]); } });
    const state: DaemonState = { dialog: promptBox };
    const h = createHandler(b, state);
    const res = await h(req("dialog-answer", [true, "typed"]));
    expect(res).toEqual({ id: 7, ok: true, result: { answered: { ...promptBox, state: "accepted", answer: "typed" } } });
    expect(b.calls).toEqual([["answerDialog", [true, "typed"]]]);
    expect(state.dialog).toBeUndefined();
    expect(await h(req("evaluate", ["1"]))).toEqual({ id: 7, ok: true, result: 42 });
  });

  test("dialog-answer accepts a prompt with its default value when no text is given", async () => {
    const b = dialogBrowser({ answerDialog: async (...a) => { b.calls.push(["answerDialog", a]); } });
    await createHandler(b, { dialog: promptBox })(req("dialog-answer", [true]));
    expect(b.calls).toEqual([["answerDialog", [true, "def"]]]);
  });

  test("dialog-answer dismisses a confirm without prompt text", async () => {
    const b = dialogBrowser({ answerDialog: async (...a) => { b.calls.push(["answerDialog", a]); } });
    const res = await createHandler(b, { dialog: confirmBox })(req("dialog-answer", [false]));
    expect(res).toEqual({ id: 7, ok: true, result: { answered: { ...confirmBox, state: "dismissed" } } });
    expect(b.calls).toEqual([["answerDialog", [false, undefined]]]);
  });

  test("with nothing pending, dialog-answer is a one-shot answer the next dialog gets at once", async () => {
    const b = dialogBrowser({ answerDialog: async (...a) => { b.calls.push(["answerDialog", a]); } });
    b.click = async () => { b.on().opened(promptBox); };
    const state: DaemonState = {};
    const h = createHandler(b, state);
    expect(await h(req("dialog-answer", [true, "typed"]))).toEqual({ id: 7, ok: true, result: {} });
    expect(b.calls).toEqual([]);
    const res = await h(req("click", ["#go"]));
    expect(res).toEqual({ id: 7, ok: true, dialogs: [{ ...promptBox, state: "accepted", answer: "typed" }] });
    expect(b.calls).toEqual([["answerDialog", [true, "typed"]]]);
    expect(state.dialog).toBeUndefined();
    // Used once: the reply drained it, and the next dialog is pending again.
    expect(await h(req("evaluate", ["1"]))).toEqual({ id: 7, ok: true, result: 42 });
    b.on().opened(confirmBox);
    expect(state.dialog).toEqual(confirmBox);
  });

  test("a navigation drops the one-shot answer", async () => {
    const b = dialogBrowser({ answerDialog: async (...a) => { b.calls.push(["answerDialog", a]); } });
    const state: DaemonState = {};
    const h = createHandler(b, state);
    await h(req("dialog-answer", [true]));
    b.on().navigated();
    b.on().opened(confirmBox);
    expect(state.dialog).toEqual(confirmBox);
    expect(b.calls).toEqual([]);
  });

  test("a dialog closed by the page itself is no longer pending", async () => {
    const b = dialogBrowser();
    const state: DaemonState = {};
    createHandler(b, state);
    b.on().opened(confirmBox);
    b.on().closed();
    expect(state.dialog).toBeUndefined();
  });

  test("urgent replies carry no dialog reports", async () => {
    const b = dialogBrowser();
    expect(await createHandler(b, { dialog: confirmBox })(req("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
  });
});

describe("dialogs: the call a dialog blocked still owns the page", () => {
  test("after the answer, the next page op does not reach the browser until the blocked click settles", async () => {
    let settle!: () => void;
    const b = dialogBrowser();
    b.click = () => { b.on().opened(confirmBox); return new Promise<void>((r) => { settle = r; }); };
    const h = createHandler(b, {}, 5_000);
    expect(await h(req("click", ["#go"]))).toMatchObject({ ok: true, dialogs: [{ state: "pending" }] });
    await h(req("dialog-answer", [true]));
    const next = h(req("evaluate", ["1"]));
    await Bun.sleep(30);
    expect(b.calls.filter(([n]) => n === "evaluate")).toEqual([]);
    settle();
    expect(await next).toEqual({ id: 7, ok: true, result: 42 });
    expect(b.calls.filter(([n]) => n === "evaluate")).toEqual([["evaluate", ["1"]]]);
  });

  test("a blocked call that never settles holds the page only for the op timeout", async () => {
    const b = dialogBrowser();
    b.click = () => { b.on().opened(confirmBox); return new Promise<void>(() => {}); };
    const h = createHandler(b, {}, 40);
    await h(req("click", ["#go"]));
    await h(req("dialog-answer", [true]));
    const t0 = performance.now();
    expect(await h(req("evaluate", ["1"]))).toEqual({ id: 7, ok: true, result: 42 });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("while the dialog is pending, state and the fail-fast error do not wait for the blocked click", async () => {
    const b = dialogBrowser();
    b.click = () => { b.on().opened(confirmBox); return new Promise<void>(() => {}); };
    const h = createHandler(b, {}, 5_000);
    await h(req("click", ["#go"]));
    const t0 = performance.now();
    expect(await h(req("state"))).toMatchObject({ ok: true, result: { dialog: confirmBox } });
    expect(await h(req("evaluate", ["1"]))).toMatchObject({ ok: false, error: OPEN_ERROR });
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
