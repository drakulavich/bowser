// End-to-end: commands of parallel CLI clients on one session run one at a
// time, whole (#77). Spec: docs/superpowers/specs/2026-09-29-session-gate-design.md,
// Definition of done items 1-6. Run with:
//
//   BOWSER_E2E=1 bun test tests/e2e-session-gate.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClose } from "../src/commands/navigation.ts";
import { killDaemons, waitFor } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const WAITING = "(waiting for another client's command on this session)";

interface Result { code: number; out: string; err: string; ms: number }
// Subprocess.kill("SIGSTOP") is a silent no-op on Bun 1.4; process.kill sends it.
function signal(proc: Subprocess, sig: NodeJS.Signals): void {
  try { process.kill(proc.pid, sig); } catch {}
}

interface Running { proc: Subprocess<"ignore", "pipe", "pipe">; result: Promise<Result> }

runOrSkip("e2e: one command at a time per session (#77)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const hits = new Map<string, number>();
  const live = new Set<Subprocess>();
  const sessions: string[] = [];
  const session = (name: string): string => {
    const s = `gate-${name}-${process.pid}`;
    sessions.push(s);
    return s;
  };

  const page = (title: string, body: string) => new Response(`<title>${title}</title>${body}`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-session-gate-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.set(path, (hits.get(path) ?? 0) + 1);
        if (path === "/form") {
          return page("form", `<label>Name <input id="n"></label>
            <label>Password <input id="p" type="password"></label>
            <label>Email <input id="e" type="email"></label>`);
        }
        if (path === "/one") {
          return page("one", `<button onclick="navigator.sendBeacon('/hit/A'); document.title = 'clicked-A'">Buy A</button>`);
        }
        if (path === "/two") {
          return page("two", `<button onclick="navigator.sendBeacon('/hit/DELETE'); document.title = 'clicked-DELETE'">DELETE</button>`);
        }
        return page(path.slice(1) || "root", `<p>${path}</p>`);
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    for (const p of live) {
      signal(p, "SIGCONT");
      signal(p, "SIGKILL");
    }
    for (const s of sessions) {
      try { await cmdClose({ session: s, json: true }); } catch {}
      await killDaemons(s);
    }
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** Start `bowser -s=<s> ...args` as its own process, killed at `deadlineMs`.
   *  The daemon reads BOWSER_OP_TIMEOUT_MS when a session's first command spawns it. */
  function start(s: string, args: string[], budgetMs = 30_000, deadlineMs = 30_000): Running {
    const t0 = Date.now();
    const proc = Bun.spawn([process.execPath, CLI, `-s=${s}`, ...args], {
      env: { ...process.env, HOME: tmp, BOWSER_OP_TIMEOUT_MS: String(budgetMs) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    live.add(proc);
    const deadline = setTimeout(() => {
      signal(proc, "SIGCONT");
      signal(proc, "SIGKILL");
    }, deadlineMs);
    const result = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([out, err, code]) => {
      clearTimeout(deadline);
      live.delete(proc);
      return { code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 };
    });
    return { proc, result };
  }

  const run = (s: string, args: string[], budgetMs?: number): Promise<Result> => start(s, args, budgetMs).result;

  async function ok(s: string, args: string[], budgetMs?: number): Promise<string> {
    const r = await run(s, args, budgetMs);
    if (r.code !== 0) throw new Error(`bowser ${args.join(" ")} exited ${r.code}: ${r.err}`);
    return r.out;
  }

  function refOf(snapshot: string, role: string, name: string): string {
    const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot);
    if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`);
    return m[1]!;
  }

  const hitCount = (path: string): number => hits.get(path) ?? 0;

  /** An eval that holds its connection: it fetches `/inflight/<tag>` once it
   *  runs in the daemon, then `/done/<tag>` just before it resolves. */
  const holdingEval = (tag: string, ms: number) =>
    `fetch('/inflight/${tag}').then(() => new Promise(r => setTimeout(r, ${ms}))).then(() => fetch('/done/${tag}')).then(() => 1)`;

  async function waitHit(path: string, ms = 10_000): Promise<void> {
    if (!(await waitFor(() => hitCount(path) > 0, ms))) throw new Error(`${path} was never fetched`);
  }

  test("ET-20: three parallel fills each land in their own field", async () => {
    const s = session("fill");
    await ok(s, ["open", `${base}/form`]);
    const texts = { Name: "Anna Petrova", Password: "TopSecretPass99", Email: "anna@example.com" };
    for (let i = 0; i < 10; i++) {
      await ok(s, ["goto", `${base}/form`]);
      const snap = await ok(s, ["snapshot"]);
      const fills = await Promise.all(
        Object.entries(texts).map(([name, text]) => run(s, ["fill", refOf(snap, "textbox", name), text])),
      );
      for (const f of fills) {
        expect(f.err).toBe("");
        expect(f.code).toBe(0);
        expect(f.out).toStartWith("filled ");
      }
      expect(JSON.parse(await ok(s, ["eval", "JSON.stringify([n.value, p.value, e.value])"])))
        .toEqual([texts.Name, texts.Password, texts.Email]);
      expect(await ok(s, ["snapshot"])).not.toContain(texts.Password);
    }
  }, 180_000);

  test("ET-16: a click raced against a goto acts on the page it resolved on, or fails", async () => {
    const s = session("click");
    await ok(s, ["open", `${base}/one`]);
    for (let i = 0; i < 10; i++) {
      await ok(s, ["goto", `${base}/one`]);
      const ref = refOf(await ok(s, ["snapshot"]), "button", "Buy A");
      const hitsA = hitCount("/hit/A");
      const holder = start(s, ["eval", "new Promise(r => setTimeout(() => r(1), 1500))"]);
      await Bun.sleep(300);
      const click = start(s, ["click", ref]);
      await Bun.sleep(300);
      const goto = start(s, ["goto", `${base}/two`]);
      const [h, c, g] = await Promise.all([holder.result, click.result, goto.result]);
      expect(h.code).toBe(0);
      expect(g.code).toBe(0);
      expect(await ok(s, ["eval", "document.title"])).toBe("two");
      if (c.code === 0) {
        expect(c.out).toBe(`clicked ${ref} (button "Buy A")`);
        expect(await waitFor(() => hitCount("/hit/A") > hitsA, 3000)).toBe(true);
      } else {
        expect(c.code).toBe(1);
        expect(c.err).toContain("not found in the current page snapshot");
      }
    }
    expect(hitCount("/hit/DELETE")).toBe(0);
  }, 180_000);

  test("ET-17: six parallel opens each report the URL they opened", async () => {
    const s = session("open");
    await ok(s, ["open", `${base}/x0`]);
    const urls = [1, 2, 3, 4, 5, 6].map((i) => `${base}/x${i}`);
    const opens = await Promise.all(urls.map((u) => run(s, ["open", u])));
    opens.forEach((o, i) => {
      expect(o.code).toBe(0);
      expect(o.out).toBe(`opened ${urls[i]}  "x${i + 1}"`);
    });
  }, 60_000);

  test("close succeeds within 2 s while a stopped client holds the session", async () => {
    const s = session("close");
    await ok(s, ["open", `${base}/c`]);
    const holder = start(s, ["eval", holdingEval("close", 5000)]);
    await waitHit("/inflight/close");
    signal(holder.proc, "SIGSTOP");
    const waiter = start(s, ["eval", "1 + 1"]);
    await Bun.sleep(300);
    const closed = await run(s, ["close"]);
    expect(closed.code).toBe(0);
    expect(closed.out).toBe(`closed session '${s}'`);
    expect(closed.ms).toBeLessThan(2000);
    signal(holder.proc, "SIGCONT");
    signal(holder.proc, "SIGKILL");
    await holder.result;
    await waiter.result;
  }, 60_000);

  test("a holder killed with kill -9 releases the session at once", async () => {
    const s = session("kill");
    await ok(s, ["open", `${base}/k`]);
    const holder = start(s, ["eval", holdingEval("kill", 300)]);
    await waitHit("/inflight/kill");
    signal(holder.proc, "SIGSTOP");
    await waitHit("/done/kill");
    // Past the eval's reply: the stopped holder is now idle, holding the gate.
    await Bun.sleep(300);
    const waiter = start(s, ["eval", "1 + 1"]);
    await Bun.sleep(1500);
    expect(waiter.proc.exitCode).toBeNull();
    const killedAt = Date.now();
    signal(holder.proc, "SIGKILL");
    const w = await waiter.result;
    expect(w.code).toBe(0);
    expect(w.out).toBe("2");
    expect(Date.now() - killedAt).toBeLessThan(1500);
    await holder.result;
  }, 60_000);

  test("an idle stopped holder loses the session after the op budget", async () => {
    const s = session("idle");
    const budget = 3000;
    await ok(s, ["open", `${base}/i`], budget);
    const holder = start(s, ["eval", holdingEval("idle", 300)], budget);
    await waitHit("/inflight/idle");
    signal(holder.proc, "SIGSTOP");
    await waitHit("/done/idle");
    const answeredAt = Date.now();
    await Bun.sleep(1000);
    const w = await start(s, ["eval", "1 + 1"], budget).result;
    expect(w.code).toBe(0);
    expect(w.out).toBe("2");
    const releasedAfter = Date.now() - answeredAt;
    expect(releasedAfter).toBeGreaterThan(budget - 500);
    expect(releasedAfter).toBeLessThan(budget + 1500);
    signal(holder.proc, "SIGCONT");
    signal(holder.proc, "SIGKILL");
    await holder.result;
  }, 60_000);

  test("a request that times out at the gate says it waited for another client", async () => {
    const s = session("wait");
    // The holder's eval must finish inside its own budget, or its reply frees the gate early.
    const budget = 2000;
    await ok(s, ["open", `${base}/w`], budget);
    const holder = start(s, ["eval", holdingEval("wait", 1500)], budget);
    await waitHit("/inflight/wait");
    signal(holder.proc, "SIGSTOP");
    const w = await start(s, ["eval", "1 + 1"], budget).result;
    expect(w.code).toBe(2);
    expect(w.err).toContain(WAITING);
    signal(holder.proc, "SIGCONT");
    signal(holder.proc, "SIGKILL");
    await holder.result;
  }, 60_000);
});
