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
import { cmdClick } from "../src/commands/interaction.ts";
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
const SLOW_MS = 3000;

runOrSkip("e2e: a session never hangs, never reports a page it has not reached", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  const sessions: string[] = [];

  /** Open a fresh session whose daemon has a budget of `budgetMs`. */
  const openWith = async (session: string, budgetMs: number): Promise<CommandContext> => {
    process.env.BOWSER_OP_TIMEOUT_MS = String(budgetMs);
    sessions.push(session);
    const ctx: CommandContext = { session, json: false };
    await cmdOpen(ctx, `${base}/`);
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
    tmp = await mkdtemp(join(tmpdir(), "bowser-hangs-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        // A server that never answers: the navigation never settles.
        if (path === "/never") return new Promise<Response>(() => {});
        if (path === "/slow" || path === "/slow2") await Bun.sleep(SLOW_MS);
        const page = { "/slow": SLOW_PAGE, "/slow2": SLOW_TWO_PAGE, "/shadowed": SHADOWED_PAGE, "/double": DOUBLE_PAGE }[path] ?? HOME_PAGE;
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  test("F9: after an eval that never settles, the next eval works or fails within its budget, recovery frees the session, and close works", async () => {
    const budget = 1000;
    const ctx = await openWith("hangeval", budget);

    // The page holds the resolver, so the promise stays reachable and never
    // settles. An unreachable one is not a hang: JSC collects it and WebKit
    // rejects the evaluate "no longer reachable" (~6 s, measured).
    const stuck = await timed(() => cmdEval(ctx, "new Promise((resolve) => { window.hold = resolve; })"));
    expect(stuck.error).toBe(`operation 'evaluate' timed out after ${budget}ms`);
    expect(stuck.ms).toBeLessThan(budget + 1000);

    // Sent at once: the reload comes after a grace (the 1 s budget here) and
    // WebKit frees the stuck evaluate ~2.4-3 s after it,
    // so this one may time out in the queue, but never past its own budget.
    const next = await timed(() => cmdEval(ctx, "1"));
    if (next.error) {
      expect(next.error).toBe(
        `operation 'evaluate' timed out after ${budget}ms (waiting for 'evaluate', which timed out and is still running; run 'bowser close' if the session stays stuck)`,
      );
    }
    expect(next.ms).toBeLessThan(budget + 1000);

    // The recovery reloaded the page: the session works again, on that page.
    let href: string | undefined;
    const deadline = performance.now() + 8000;
    while (href === undefined && performance.now() < deadline) {
      try { href = await cmdEval(ctx, "location.href"); } catch { await Bun.sleep(200); }
    }
    expect(href).toBe(`${base}/`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, 30_000);

  test("F9: after a goto whose server never answers, the next command is bounded by its budget", async () => {
    const budget = 1000;
    const ctx = await openWith("hanggoto", budget);

    const stuck = await timed(() => cmdGoto(ctx, `${base}/never`));
    expect(stuck.error).toBe(`operation 'navigate' timed out after ${budget}ms`);

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
  }, 30_000);
});
