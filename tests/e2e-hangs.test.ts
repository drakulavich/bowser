// End-to-end: a session never hangs, and never reports a page it has not
// reached yet. Spec F9 and F10: docs/superpowers/specs/2026-09-26-p0-hangs-design.md.
//
// - F10: a click on a link to a page the server answers after 3 s waits for
//   that page; on WebKit only the page's navigate event shows the navigation
//   before the response arrives.
// - F9: an op that never settles fails at its budget; if it is still running
//   after a grace, the daemon reloads the page to free the WebView. Every
//   later request is bounded by its own budget, queue time included. `close`
//   always works.
//
// The daemon reads BOWSER_OP_TIMEOUT_MS when it spawns, so each session is
// opened with the budget its test needs.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-hangs.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick, cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

const HOME_PAGE = `<!doctype html><title>Home</title>
<a href="/slow">Slow</a>
<button onclick="document.body.dataset.clicked = 'yes'">Stay</button>`;
const SLOW_PAGE = `<!doctype html><title>Slow</title><h1>Arrived</h1>`;
const SLOW_TWO_PAGE = `<!doctype html><title>Slow two</title><h1>Arrived twice</h1>`;
/** A page whose own global lexical `navigation` shadows the Navigation API
 *  for unqualified references in any script evaluated there. */
const SHADOWED_PAGE = `<!doctype html><title>Shadowed</title>
<script>let navigation = {};</script>
<a href="/slow">Slow</a>`;
/** A click that starts one slow navigation and, 200 ms later, replaces it
 *  with another: WebKit cancels the first (-999) while the second loads. */
const DOUBLE_PAGE = `<!doctype html><title>Double</title>
<button onclick="location.href = '/slow'; setTimeout(() => { location.href = '/slow2'; }, 200)">Twice</button>`;
/** ET-10 (#78): Send posts to a server that never answers. */
const FORM_PAGE = `<!doctype html><title>Form</title>
<form action="/never" method="post"><input name="a" aria-label="First"><input name="b" aria-label="Second"><button>Send</button></form>`;
const SLOW_MS = 3000;
/** openWith's retry window, from its start. It may overrun by one budget,
 *  so a test that opens with it adds both to its own timeout. */
const OPEN_MS = 20_000;
const openTimeout = (budgetMs: number, bodyMs: number): number => OPEN_MS + budgetMs + bodyMs;
/** #98: Send posts to a server that never answers; 11 s later, after the
 *  navigation watch has given up, a script replaces that POST with another
 *  navigation that never answers either. */
const REDIRECT_PAGE = `<!doctype html><title>Redirect</title>
<form action="/never" method="post" onsubmit="setTimeout(() => { location.href = '/never2'; }, 11000)"><input name="b" aria-label="Second"><button>Send</button></form>`;

runOrSkip("e2e: a session never hangs, never reports a page it has not reached", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  let never2Requested: Promise<void> = Promise.resolve();
  let resolveNever2Requested = () => {};
  const sessions: string[] = [];

  /** Open a fresh session whose daemon has a budget of `budgetMs`, on the
   *  home page. This is setup, not the behaviour under test: a new daemon's
   *  first navigation can overrun a 1 s budget on a slow runner (CI run
   *  36294974018 failed in the F9 goto test's `open` with "'navigate' timed
   *  out"). The daemon keeps running, so a timed-out open is followed by
   *  `goto`s until one lands; each is bounded by the budget. */
  const openWith = async (session: string, budgetMs: number): Promise<CommandContext> => {
    process.env.BOWSER_OP_TIMEOUT_MS = String(budgetMs);
    sessions.push(session);
    const ctx: CommandContext = { session, json: false };
    const deadline = performance.now() + OPEN_MS;
    let landed = await timed(() => cmdOpen(ctx, `${base}/`));
    while (landed.error !== undefined) {
      expect(landed.error).toContain("timed out after");
      if (performance.now() > deadline) throw new Error(`setup: ${session} never reached ${base}/: ${landed.error}`);
      await Bun.sleep(200);
      landed = await timed(() => cmdGoto(ctx, `${base}/`));
    }
    return ctx;
  };

  /** How long `fn` took, and what it threw, if anything. */
  const timed = async (fn: () => Promise<unknown>): Promise<{ ms: number; error?: string }> => {
    const t0 = performance.now();
    try {
      await fn();
      return { ms: performance.now() - t0 };
    } catch (err) {
      return { ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  };

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    never2Requested = new Promise<void>((resolve) => { resolveNever2Requested = resolve; });
    tmp = await mkdtemp(join(tmpdir(), "bowser-hangs-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        // A server that never answers: the navigation never settles.
        if (path === "/never" || path === "/never2") {
          if (path === "/never2") resolveNever2Requested();
          return new Promise<Response>(() => {});
        }
        if (path === "/slow" || path === "/slow2") await Bun.sleep(SLOW_MS);
        const page = { "/slow": SLOW_PAGE, "/slow2": SLOW_TWO_PAGE, "/shadowed": SHADOWED_PAGE, "/double": DOUBLE_PAGE, "/form": FORM_PAGE, "/redirect": REDIRECT_PAGE }[path] ?? HOME_PAGE;
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    for (const session of sessions) {
      try { await cmdClose({ session, json: false }); } catch {}
    }
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  test("F10: click on a link to a page served after 3 s waits for it, and snapshot shows it", async () => {
    const ctx = await openWith("slownav", 8000);
    await cmdSnapshot(ctx);
    const refs = (await loadState(ctx.session))!.refs;
    const link = refs.find((r) => r.name === "Slow")!.id;
    const stay = refs.find((r) => r.name === "Stay")!.id;

    // An action that navigates nowhere still costs only the grace window.
    const still = await timed(() => cmdClick(ctx, stay));
    expect(still.error).toBeUndefined();
    expect(still.ms).toBeLessThan(1000);

    const click = await timed(() => cmdClick(ctx, link));
    expect(click.error).toBeUndefined();
    expect(click.ms).toBeGreaterThanOrEqual(SLOW_MS - 500);

    const snap = await cmdSnapshot(ctx);
    expect(snap).toContain(`- Page URL: ${base}/slow`);
    expect(snap).toContain("- Page Title: Slow");
    expect(snap).toContain('heading "Arrived"');
  }, openTimeout(8000, 30_000));

  test("F10: a page whose own `navigation` shadows the Navigation API still has its slow click awaited", async () => {
    const ctx = await openWith("shadowed", 8000);
    await cmdGoto(ctx, `${base}/shadowed`);
    await cmdSnapshot(ctx);
    const link = (await loadState(ctx.session))!.refs.find((r) => r.name === "Slow")!.id;
    const click = await timed(() => cmdClick(ctx, link));
    expect(click.error).toBeUndefined();
    const snap = await cmdSnapshot(ctx);
    expect(snap).toContain(`- Page URL: ${base}/slow`);
    expect(snap).toContain("- Page Title: Slow");
  }, openTimeout(8000, 30_000));

  test("F10: a navigation that replaces the one the click started is awaited too", async () => {
    const ctx = await openWith("double", 12000);
    await cmdGoto(ctx, `${base}/double`);
    await cmdSnapshot(ctx);
    const button = (await loadState(ctx.session))!.refs.find((r) => r.name === "Twice")!.id;
    const click = await timed(() => cmdClick(ctx, button));
    expect(click.error).toBeUndefined();
    // The second page is requested at ~200 ms and served 3 s later.
    expect(click.ms).toBeGreaterThanOrEqual(SLOW_MS);
    const snap = await cmdSnapshot(ctx);
    expect(snap).toContain(`- Page URL: ${base}/slow2`);
    expect(snap).toContain("- Page Title: Slow two");
  }, openTimeout(12000, 30_000));

  test("F9: after an eval that never settles, the next eval works or fails within its budget, recovery frees the session, and close works", async () => {
    const budget = 1000;
    const ctx = await openWith("hangeval", budget);

    // The page holds the resolver, so the promise stays reachable and never
    // settles. An unreachable one is not a hang: JSC collects it and WebKit
    // rejects the evaluate "no longer reachable" (~6 s, measured).
    // `command` is what run() sets: the timeout names the command (F21).
    const stuck = await timed(() => cmdEval({ ...ctx, command: "eval" }, "new Promise((resolve) => { window.hold = resolve; })"));
    expect(stuck.error).toBe(`'eval' timed out after ${budget}ms (in its 'evaluate' step)`);
    expect(stuck.ms).toBeLessThan(budget + 1000);

    // Sent at once: the reload comes after a grace (the 1 s budget here) and
    // WebKit frees the stuck evaluate ~2.4-3 s after it,
    // so this one may time out in the queue, but never past its own budget.
    const next = await timed(() => cmdEval(ctx, "1"));
    if (next.error) {
      expect(next.error).toBe(
        `'evaluate' timed out after ${budget}ms (waiting for 'evaluate', which timed out and is still running; run 'bowser close' if the session stays stuck)`,
      );
    }
    expect(next.ms).toBeLessThan(budget + 1000);

    // Spec F9: from here each command either works, after the recovery
    // reload freed the evaluate, or fails fast in the queue within its own
    // budget. Locally the reload frees it ~2.4-3 s after it runs; on the CI
    // runner it had not within 8 s (PR #46), so both outcomes are accepted
    // and neither may take longer than a budget. Recovery itself is pinned
    // by the goto test below and the dispatch unit tests.
    //
    // A third outcome, also within F9: the lane frees while an attempt is
    // queued, so it runs on what is left of its budget from receipt, and can
    // overrun it there. It then fails as a running op, without the "waiting
    // for" tail (CI run 36299769857; pinned by the dispatch unit test "a
    // request that reaches the head of the queue with too little budget
    // left …"). It is still bounded by its budget.
    const QUEUED = `'eval' timed out after ${budget}ms (in its 'evaluate' step) (waiting for 'evaluate', which timed out and is still running; run 'bowser close' if the session stays stuck)`;
    const RAN_OUT = `'eval' timed out after ${budget}ms (in its 'evaluate' step)`;
    // Where the reload did not free it (CI), the session is marked stuck
    // until it settles, and each attempt is answered at once (#78).
    const STUCK = "session is stuck: 'eval' is still running after a reload; run 'bowser close'";
    let href: string | undefined;
    const deadline = performance.now() + 20_000;
    while (href === undefined && performance.now() < deadline) {
      const attempt = await timed(async () => { href = await cmdEval({ ...ctx, command: "eval" }, "location.href"); });
      expect(attempt.ms).toBeLessThan(budget + 1000);
      if (attempt.error) {
        expect([QUEUED, RAN_OUT, STUCK]).toContain(attempt.error);
        await Bun.sleep(200);
      }
    }
    if (href !== undefined) expect(href).toBe(`${base}/`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, openTimeout(1000, 45_000));

  test("F9: after a goto whose server never answers, the next command is bounded by its budget", async () => {
    const budget = 1000;
    const ctx = await openWith("hanggoto", budget);

    const stuck = await timed(() => cmdGoto({ ...ctx, command: "goto" }, `${base}/never`));
    expect(stuck.error).toBe(`'goto' timed out after ${budget}ms (in its 'navigate' step)`);

    // Sent at once: the daemon reloads only after a grace (the 1 s budget
    // here), so this may time out in the queue, but never past its budget.
    const next = await timed(() => cmdEval(ctx, "location.href"));
    expect(next.ms).toBeLessThan(budget + 1000);
    if (next.error) expect(next.error).toContain("(waiting for 'navigate', which timed out and is still running");

    // The reload cancels the stuck navigation at once: the session works
    // again, on the page it was on.
    let href: string | undefined;
    const deadline = performance.now() + 5000;
    while (href === undefined && performance.now() < deadline) {
      try { href = await cmdEval(ctx, "location.href"); } catch { await Bun.sleep(200); }
    }
    expect(href).toBe(`${base}/`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, openTimeout(1000, 30_000));

  // #48: from a fresh session nothing has committed yet (the view's url is
  // ""), so reload() has no page to reload and does nothing, and WebKit
  // refuses navigate() while one is pending. Before the fix every later
  // command failed at its budget until `close`.
  test("#48: after a first goto from about:blank whose server never answers, recovery frees the session", async () => {
    const budget = 1000;
    process.env.BOWSER_OP_TIMEOUT_MS = String(budget);
    const ctx: CommandContext = { session: "hangfirst", json: false };
    sessions.push(ctx.session);
    await cmdOpen(ctx);

    const stuck = await timed(() => cmdGoto({ ...ctx, command: "goto" }, `${base}/never`));
    expect(stuck.error).toBe(`'goto' timed out after ${budget}ms (in its 'navigate' step)`);

    // Recovery runs a grace (the budget) after the timeout; each attempt
    // until then fails within its own budget.
    let landed: string | undefined;
    const deadline = performance.now() + 10_000;
    while (landed === undefined && performance.now() < deadline) {
      const attempt = await timed(async () => { landed = await cmdGoto(ctx, `${base}/`); });
      expect(attempt.ms).toBeLessThan(budget + 1000);
      if (attempt.error) await Bun.sleep(200);
    }
    expect(landed).toContain(`${base}/`);
    expect(await cmdEval(ctx, "location.href")).toBe(`${base}/`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, 30_000);

  // #67: from a fresh session (url "") recovery's location.replace is itself
  // an evaluate, and WebKit refuses it while the stuck one is pending; reload()
  // has no page. Before the fix every later command failed in the queue until
  // `close` (still stuck at 90 s, measured). navigate("about:blank") frees the
  // stuck evaluate ~3.2 s after it runs (measured on a bare WebView).
  test("#67: after an eval that never settles in a fresh session, recovery frees the session", async () => {
    const budget = 1000;
    process.env.BOWSER_OP_TIMEOUT_MS = String(budget);
    const ctx: CommandContext = { session: "hangfresh", json: false };
    sessions.push(ctx.session);
    await cmdOpen(ctx);

    const stuck = await timed(() => cmdEval({ ...ctx, command: "eval" }, "new Promise((resolve) => { window.hold = resolve; })"));
    expect(stuck.error).toBe(`'eval' timed out after ${budget}ms (in its 'evaluate' step)`);

    // Recovery runs a grace (the budget) after the timeout, and the stuck
    // evaluate is freed ~3.2 s after that. Each attempt until then fails
    // within its own budget; the session must answer well before the deadline.
    const t0 = performance.now();
    let href: string | undefined;
    const deadline = t0 + 15_000;
    while (href === undefined && performance.now() < deadline) {
      const attempt = await timed(async () => { href = await cmdEval({ ...ctx, command: "eval" }, "location.href"); });
      expect(attempt.ms).toBeLessThan(budget + 1000);
      if (attempt.error) await Bun.sleep(200);
    }
    expect(href).toBe("about:blank");

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, 30_000);

  // ET-10 (#78): a selector click started while the page's POST is still
  // unanswered never resolved on WebKit, so this fill hung until its budget.
  test("ET-10: after a submit to a server that never answers, the next fill types or says the page is still loading, within its budget", async () => {
    const ctx = await openWith("et10", 30_000);
    await cmdGoto(ctx, `${base}/form`);
    await cmdSnapshot(ctx);
    const refs = (await loadState(ctx.session))!.refs;
    const ref = (name: string) => refs.find((r) => r.name === name)!.id;
    await cmdFill(ctx, ref("First"), "hello");
    // Returns at the navigation watch's 10 s cap with the POST still pending.
    const submit = await timed(() => cmdClick(ctx, ref("Send")));
    expect(submit.error).toBeUndefined();

    process.env.BOWSER_OP_TIMEOUT_MS = "3000";
    const fill = await timed(() => cmdFill({ ...ctx, command: "fill" }, ref("Second"), "AFTER"));
    expect(fill.ms).toBeLessThan(3500);
    if (fill.error) expect(fill.error).toBe(`page is still loading ${base}/never; retry later, or run 'bowser close'`);
    else expect(await cmdEval(ctx, "document.querySelector('[name=b]').value")).toBe("AFTER");

    // The daemon's budget is 30 s; the timeout names the command's own.
    const hung = await timed(() => cmdEval({ ...ctx, command: "eval" }, "new Promise(() => {})"));
    expect(hung.error).toBe("'eval' timed out after 3000ms (in its 'evaluate' step)");

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(2000);
  }, openTimeout(30_000, 40_000));

  test("#98: a navigation that replaces the pending one after the watch ends still holds the next fill", async () => {
    const ctx = await openWith("replaced", 30_000);
    await cmdGoto(ctx, `${base}/redirect`);
    await cmdSnapshot(ctx);
    const refs = (await loadState(ctx.session))!.refs;
    const ref = (name: string) => refs.find((r) => r.name === name)!.id;
    const submit = await timed(() => cmdClick(ctx, ref("Send")));
    expect(submit.error).toBeUndefined();
    // Wait for the server to see the replacement request. The page's 11 s
    // timer starts at submit, before cmdClick returns; bound this wait so a
    // broken repro cannot hold the suite indefinitely.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const requested = await Promise.race([
      never2Requested.then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 15_000); }),
    ]);
    clearTimeout(timeout);
    expect(requested).toBe(true);

    process.env.BOWSER_OP_TIMEOUT_MS = "3000";
    const fill = await timed(() => cmdFill({ ...ctx, command: "fill" }, ref("Second"), "AFTER"));
    expect(fill.error).toBe(`page is still loading ${base}/never2; retry later, or run 'bowser close'`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
  }, openTimeout(30_000, 60_000));
});
