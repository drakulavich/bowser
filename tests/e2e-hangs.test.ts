// End-to-end: a session never hangs, and never reports a page it has not
// reached yet. Spec F9 and F10: docs/superpowers/specs/2026-09-26-p0-hangs-design.md.
//
// - F10: a click on a link to a page the server answers after 3 s waits for
//   that page; on WebKit only the page's navigate event shows the navigation
//   before the response arrives.
// - F9: an op that never settles fails at its budget, the daemon reloads the
//   page to free the WebView, and every later request is bounded by its own
//   budget, queue time included. `close` always works.
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
        if (path === "/slow") await Bun.sleep(SLOW_MS);
        return new Response(path === "/slow" ? SLOW_PAGE : HOME_PAGE, {
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

  test("F9: after an eval that never settles, the next eval works or fails within its budget, recovery frees the session, and close works", async () => {
    const budget = 1000;
    const ctx = await openWith("hangeval", budget);

    // The page holds the resolver, so the promise stays reachable and never
    // settles. An unreachable one is not a hang: JSC collects it and WebKit
    // rejects the evaluate "no longer reachable" (~6 s, measured).
    const stuck = await timed(() => cmdEval(ctx, "new Promise((resolve) => { window.hold = resolve; })"));
    expect(stuck.error).toBe(`operation 'evaluate' timed out after ${budget}ms`);
    expect(stuck.ms).toBeLessThan(budget + 1000);

    // Sent at once: WebKit frees the stuck evaluate ~2.4 s after the reload,
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

    // The reload cancels the stuck navigation at once, so this runs, on the
    // page the session was on.
    const next = await timed(() => cmdEval(ctx, "location.href"));
    expect(next.ms).toBeLessThan(budget + 1000);
    expect(next.error).toBeUndefined();
    expect(await cmdEval(ctx, "location.href")).toBe(`${base}/`);

    const close = await timed(() => cmdClose(ctx));
    expect(close.error).toBeUndefined();
    expect(close.ms).toBeLessThan(5000);
  }, 30_000);
});
