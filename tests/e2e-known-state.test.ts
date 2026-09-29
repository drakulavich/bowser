// End-to-end: after a timeout the next command works on a settled page or
// fails at once with a message that says what to do (#78). Spec:
// docs/superpowers/specs/2026-09-29-known-state-after-timeout-design.md,
// Definition of done items 1-6. Item 3 (ET-10) is the ET-10 test in
// tests/e2e-hangs.test.ts. Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-known-state.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClose } from "../src/commands/navigation.ts";
import { killDaemons } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const stuck = (cmd: string) => `bowser: session is stuck: '${cmd}' is still running after a reload; run 'bowser close'`;

interface Result { code: number; out: string; err: string; ms: number }

runOrSkip("e2e: a known state after a timeout (#78)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const live = new Set<Subprocess>();
  const sessions: string[] = [];
  const session = (name: string): string => {
    const s = `known-${name}-${process.pid}`;
    sessions.push(s);
    return s;
  };

  const html = (body: string) => new Response(`<!doctype html>${body}`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-known-state-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/never") return new Promise<Response>(() => {});
        if (path === "/slow") {
          await Bun.sleep(3000);
          return html("<title>Slow</title><h1>Arrived</h1>");
        }
        if (path === "/busy") {
          // Each of fill's steps (the focus click, then setting the value) costs 2 s.
          return html(`<title>Busy</title><script>const spin = () => { const t = Date.now(); while (Date.now() - t < 2000); };</script>
            <input aria-label="Name" onclick="spin()" oninput="spin()">`);
        }
        return html(`<title>Home</title><a href="/never">Never</a> <a href="/slow">Slow</a>`);
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    for (const p of live) p.kill("SIGKILL");
    for (const s of sessions) {
      try { await cmdClose({ session: s, json: true }); } catch {}
      await killDaemons(s);
    }
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** `bowser -s=<s> ...args` as its own process, killed at `deadlineMs`. The
   *  daemon reads BOWSER_OP_TIMEOUT_MS when a session's first command spawns it. */
  async function run(s: string, args: string[], budgetMs: number, deadlineMs = 20_000): Promise<Result> {
    const t0 = Date.now();
    const proc = Bun.spawn([process.execPath, CLI, `-s=${s}`, ...args], {
      env: { ...process.env, HOME: tmp, BOWSER_OP_TIMEOUT_MS: String(budgetMs) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    live.add(proc);
    const deadline = setTimeout(() => proc.kill("SIGKILL"), deadlineMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(deadline);
    live.delete(proc);
    return { code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 };
  }

  async function ok(s: string, args: string[], budgetMs: number): Promise<string> {
    const r = await run(s, args, budgetMs);
    if (r.code !== 0) throw new Error(`bowser ${args.join(" ")} exited ${r.code}: ${r.err}`);
    return r.out;
  }

  function refOf(snapshot: string, role: string, name: string): string {
    const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot);
    if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`);
    return m[1]!;
  }

  async function closesFast(s: string): Promise<void> {
    const close = await run(s, ["close"], 30_000);
    expect(close.code).toBe(0);
    expect(close.ms).toBeLessThan(2000);
  }

  test("ET-09: after a click to a server that never answers, the next eval sees the reloaded page or says the session is stuck", async () => {
    const budget = 3000;
    for (let i = 0; i < 5; i++) {
      const s = session(`et09-${i}`);
      await ok(s, ["open", `${base}/`], budget);
      await ok(s, ["eval", "window.before = 'pre-reload'"], budget);
      const link = refOf(await ok(s, ["snapshot"], budget), "link", "Never");

      const click = await run(s, ["click", link], budget);
      expect(click.code).toBe(2);
      expect(click.err).toContain(`'click' timed out after ${budget}ms`);

      const next = await run(s, ["eval", "location.href + ' ' + (window.before ?? 'reloaded')"], budget);
      expect(next.ms).toBeLessThan(budget + 500);
      if (next.code === 0) expect(next.out).toBe(`${base}/ reloaded`);
      else expect([next.code, next.err]).toEqual([2, stuck("click")]);

      await closesFast(s);
    }
  }, 120_000);

  // The page cannot resolve the promise itself: the reload replaced its
  // document, and a timer there never fires. WebKit frees the evaluate ~4 s
  // after the reload (measured), which is what ends the stuck state here.
  const HOLD = "new Promise((resolve) => { window.hold = resolve; })";
  const HUNG = "bowser: 'eval' timed out after 3000ms (in its 'evaluate' step)";

  test("ET-12: while a reachable promise outlives recovery, every command fails fast as stuck; once it settles the session works", async () => {
    const budget = 3000;
    const s = session("et12");
    await ok(s, ["open", `${base}/`], budget);
    const hung = await run(s, ["eval", HOLD], budget);
    expect([hung.code, hung.err]).toEqual([2, HUNG]);

    // The first command waits out the recovery's grace (2 s) in the queue.
    const first = await run(s, ["eval", "location.href"], budget);
    expect(first.ms).toBeLessThan(budget + 500);
    expect([first.code, first.err]).toEqual([2, stuck("eval")]);

    let href: string | undefined;
    const deadline = Date.now() + 20_000;
    while (href === undefined && Date.now() < deadline) {
      const r = await run(s, ["eval", "location.href"], budget);
      if (r.code === 0) href = r.out;
      else {
        expect([r.code, r.err]).toEqual([2, stuck("eval")]);
        expect(r.ms).toBeLessThan(1000);
        await Bun.sleep(100);
      }
    }
    expect(href).toBe(`${base}/`);

    await closesFast(s);
  }, 60_000);

  test("close works while the session is stuck", async () => {
    const budget = 3000;
    const s = session("et12close");
    await ok(s, ["open", `${base}/`], budget);
    expect((await run(s, ["eval", HOLD], budget)).err).toBe(HUNG);
    expect((await run(s, ["eval", "1"], budget)).err).toBe(stuck("eval"));

    await closesFast(s);
  }, 60_000);

  test("ET-15: a click whose page takes longer than the budget says the click was delivered", async () => {
    const budget = 3000;
    const s = session("et15msg");
    await ok(s, ["open", `${base}/`], budget);
    const link = refOf(await ok(s, ["snapshot"], budget), "link", "Slow");

    const click = await run(s, ["click", link], budget);
    expect([click.code, click.err]).toEqual([
      2,
      `bowser: 'click' timed out after ${budget}ms waiting for the page it opened; the click was delivered, check the page before retrying`,
    ]);
    // Delivered: the page it opened loads.
    let href = "";
    const deadline = Date.now() + 10_000;
    while (href !== `${base}/slow` && Date.now() < deadline) {
      const r = await run(s, ["eval", "location.href"], budget);
      href = r.out;
      if (r.code !== 0) await Bun.sleep(200);
    }
    expect(href).toBe(`${base}/slow`);

    await closesFast(s);
  }, 60_000);

  test("ET-15: a fill whose steps are each slow answers within its budget", async () => {
    const budget = 3000;
    const s = session("et15budget");
    await ok(s, ["open", `${base}/busy`], budget);
    const input = refOf(await ok(s, ["snapshot"], budget), "textbox", "Name");

    const fill = await run(s, ["fill", input, "hello"], budget);
    expect(fill.ms).toBeLessThan(3500);

    await closesFast(s);
  }, 60_000);
});
