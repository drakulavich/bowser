// End-to-end on the WebKit backend: every command that works without CDP,
// driven the way an agent would drive it (snapshot → ref → act → read back).
// Page state is verified with `eval` so a passing test proves the DOM
// changed, not just that the command returned.
//
// macOS only (webkit is a macOS backend). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-webkit.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import {
  cmdCheck, cmdClick, cmdFill, cmdHover, cmdPress, cmdResize, cmdSelect, cmdType, cmdUncheck,
} from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdHistory, cmdList, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval, cmdRunCode } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import {
  cmdLocalStorageClear, cmdLocalStorageDelete, cmdLocalStorageGet,
  cmdLocalStorageList, cmdLocalStorageSet, cmdSessionStorageClear,
  cmdSessionStorageGet, cmdSessionStorageList, cmdSessionStorageSet,
} from "../src/commands/web-storage.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: WebKit agent loop", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origBackend: string | undefined;
  let server: { stop: () => void } | undefined;
  let base: string;

  const session = "wk";
  const ctx: CommandContext = { session, json: true };
  const text: CommandContext = { session, json: false };

  beforeAll(async () => {
    origHome = process.env.HOME;
    origBackend = process.env.BOWSER_BACKEND;
    tmp = await mkdtemp(join(tmpdir(), "bowser-webkit-"));
    process.env.HOME = tmp;
    // Force webkit even on a machine with `bowser install`ed Chromium. The
    // daemon inherits the live env, so this reaches it.
    process.env.BOWSER_BACKEND = "webkit";

    const sink = await readFile(join(import.meta.dir, "fixtures/kitchen-sink.html"), "utf8");
    const two = `<!doctype html><html><head><title>Page Two</title></head><body><main><h1>Two</h1><a href="/">Back home</a></main></body></html>`;
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        const body = new URL(req.url).pathname === "/two" ? two : sink;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    server = { stop: () => s.stop(true) };
    base = s.url.toString(); // ends with "/"
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origBackend === undefined) delete process.env.BOWSER_BACKEND;
    else process.env.BOWSER_BACKEND = origBackend;
    await rm(tmp, { recursive: true, force: true });
  });

  /** Ref id for the most recent snapshot's element with this accessible name. */
  async function refNamed(name: string): Promise<string> {
    const state = await loadState(session);
    const r = state?.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in last snapshot`);
    return r.id;
  }

  /** Evaluate an expression in the page and return its printed result. */
  const evalText = (expr: string) => cmdEval(text, expr);

  /** Navigation settles asynchronously; poll until `expr` prints `want`. */
  async function waitForEval(expr: string, want: string, ms = 5000): Promise<void> {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < ms) {
      last = await evalText(expr);
      if (last === want) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${expr} === ${JSON.stringify(want)}; last was ${JSON.stringify(last)}`);
  }

  test("open reports the real title (WebKit title fallback)", async () => {
    const out = JSON.parse(await cmdOpen(ctx, base)) as { ok: boolean; url: string; title: string };
    expect(out.ok).toBe(true);
    expect(out.url).toBe(base);
    expect(out.title).toBe("Kitchen Sink");
  }, 60_000);

  test("snapshot lists every interactive element with a ref", async () => {
    const yaml = await cmdSnapshot(text);
    for (const line of [
      'textbox "Name": [ref=',
      'combobox "Color": [ref=',
      'checkbox "Agree": [ref=',
      'button "Submit": [ref=',
      'button "Hover me": [ref=',
      'link "Page two": [ref=',
    ]) {
      expect(yaml).toContain(line);
    }
  }, 60_000);

  test("fill, type and press Enter submit the form", async () => {
    await cmdSnapshot(text);
    const name = await refNamed("Name");
    await cmdFill(ctx, name, "Ada");
    await cmdType(ctx, " Lovelace");
    expect(await evalText("document.getElementById('name').value")).toBe("Ada Lovelace");
    await cmdPress(ctx, "Enter");
    await waitForEval("document.getElementById('submitted').textContent", "submitted:Ada Lovelace");
  }, 60_000);

  test.todo("press dispatches a bubbling keydown to document: WebKit's native press submits the form but fires no keydown listener (Bun.WebView.press limitation)", async () => {
    expect(await evalText("document.getElementById('keys').textContent")).toContain("Enter;");
  }, 60_000);

  test("select fires change with the chosen value", async () => {
    await cmdSnapshot(text);
    await cmdSelect(ctx, await refNamed("Color"), "blue");
    expect(await evalText("document.getElementById('color').value")).toBe("blue");
    expect(await evalText("document.getElementById('submitted').textContent")).toBe("color:blue");
  }, 60_000);

  test("check and uncheck toggle the checkbox", async () => {
    await cmdSnapshot(text);
    const agree = await refNamed("Agree");
    await cmdCheck(ctx, agree);
    expect(await evalText("String(document.getElementById('agree').checked)")).toBe("true");
    await cmdUncheck(ctx, agree);
    expect(await evalText("String(document.getElementById('agree').checked)")).toBe("false");
  }, 60_000);

  test("hover fires mouseover", async () => {
    await cmdSnapshot(text);
    await cmdHover(ctx, await refNamed("Hover me"));
    expect(await evalText("document.getElementById('hovered').textContent")).toBe("hovered");
  }, 60_000);

  test("resize changes the viewport the page sees", async () => {
    const out = JSON.parse(await cmdResize(ctx, "900", "700")) as { ok: boolean };
    expect(out.ok).toBe(true);
    await waitForEval("innerWidth + 'x' + innerHeight", "900x700");
    // The fixture's resize listener writes #size; proves the event fired, not just the metrics.
    await waitForEval("document.getElementById('size').textContent", "900x700");
  }, 60_000);

  test("click a link, then go-back, go-forward, goto", async () => {
    await cmdSnapshot(text);
    const out = JSON.parse(await cmdClick(ctx, await refNamed("Page two"))) as { ok: boolean };
    expect(out.ok).toBe(true);
    // The page itself is the witness that the click navigated; what `click`
    // reports is checked by the next test.
    await waitForEval("document.title", "Page Two");
    expect(await evalText("location.pathname")).toBe("/two");

    await cmdHistory(ctx, "back");
    await waitForEval("document.title", "Kitchen Sink");

    await cmdHistory(ctx, "forward");
    await waitForEval("document.title", "Page Two");

    const gone = JSON.parse(await cmdGoto(ctx, base)) as { url: string };
    expect(gone.url).toBe(base);
    await waitForEval("document.title", "Kitchen Sink");
    // The daemon persists the title it resolved (WebKit fallback path); check the stored one too.
    expect((await loadState(session))?.title).toBe("Kitchen Sink");
  }, 90_000);

  test("click reports the post-navigation url", async () => {
    await cmdGoto(ctx, base);
    await waitForEval("document.title", "Kitchen Sink");
    await cmdSnapshot(text);
    const out = JSON.parse(await cmdClick(ctx, await refNamed("Page two"))) as { url: string };
    expect(out.url).toBe(base + "two");
    await cmdGoto(ctx, base);
    await waitForEval("document.title", "Kitchen Sink");
  }, 60_000);

  test("reload reloads the current page", async () => {
    await cmdGoto(ctx, base + "two");
    await waitForEval("document.title", "Page Two");
    const out = JSON.parse(await cmdHistory(ctx, "reload")) as { ok: boolean };
    expect(out.ok).toBe(true);
    // A per-load marker, not the title: the title already holds before the
    // reload, so waiting on it would prove nothing.
    await waitForEval("performance.getEntriesByType('navigation')[0].type", "reload");
    expect(await evalText("document.title")).toBe("Page Two");
    // Restore the shared session to the Kitchen Sink page: later tests in
    // this file (localStorage/sessionStorage/eval) assume it's loaded.
    await cmdGoto(ctx, base);
    await waitForEval("document.title", "Kitchen Sink");
  }, 60_000);

  test("reload then goto: reload waits for its navigation to land", async () => {
    await cmdSnapshot(text);
    const out = JSON.parse(await cmdClick(ctx, await refNamed("Page two"))) as { url: string };
    await waitForEval("document.title", "Page Two");
    expect(out.url.endsWith("/two") || (await evalText("location.pathname")) === "/two").toBe(true);

    await cmdHistory(ctx, "back");
    await waitForEval("document.title", "Kitchen Sink");

    await cmdHistory(ctx, "forward");
    await waitForEval("document.title", "Page Two");

    const reloaded = JSON.parse(await cmdHistory(ctx, "reload")) as { ok: boolean };
    expect(reloaded.ok).toBe(true);
    // No wait here on purpose: the -999 failure needed goto to arrive while
    // the reload's navigation was still in flight.

    const gone = JSON.parse(await cmdGoto(ctx, base)) as { url: string };
    expect(gone.url).toBe(base);
    await waitForEval("document.title", "Kitchen Sink");
  }, 90_000);

  test("localStorage round-trip", async () => {
    await cmdLocalStorageSet(ctx, "k1", "v1");
    await cmdLocalStorageSet(ctx, "k2", "v2");
    expect(await cmdLocalStorageGet(text, "k1")).toBe("v1");
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({ k1: "v1", k2: "v2" });
    await cmdLocalStorageDelete(ctx, "k1");
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({ k2: "v2" });
    await cmdLocalStorageClear(ctx);
    expect(JSON.parse(await cmdLocalStorageList(ctx))).toEqual({});
  }, 60_000);

  test("sessionStorage round-trip", async () => {
    await cmdSessionStorageSet(ctx, "s1", "x");
    expect(await cmdSessionStorageGet(text, "s1")).toBe("x");
    expect(JSON.parse(await cmdSessionStorageList(ctx))).toEqual({ s1: "x" });
    await cmdSessionStorageClear(ctx);
    expect(JSON.parse(await cmdSessionStorageList(ctx))).toEqual({});
  }, 60_000);

  test("eval and run-code return page values", async () => {
    expect(await evalText("1 + 1")).toBe("2");
    expect(await cmdRunCode(text, "const t = document.title; return t.toUpperCase();")).toBe("KITCHEN SINK");
  }, 60_000);

  test("list shows the session; close --all ends it", async () => {
    expect(JSON.parse(await cmdList(ctx)) as string[]).toContain(session);
    const out = JSON.parse(await cmdClose(ctx, { all: true })) as { ok: boolean; closed: string[] };
    expect(out.ok).toBe(true);
    expect(out.closed).toContain(session);
    const after = await loadState(session);
    expect(after?.url).toBe("");
  }, 60_000);
});
