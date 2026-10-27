// End-to-end: after an upgrade, a session the old bowser started is restarted
// by the new one, and a running `bowser mcp` hands over to the installed
// version (#145). Spec: docs/superpowers/specs/2026-10-14-upgrade-restart-design.md.
// The old bowser is a copy of this package with another version in its
// package.json. Run with:
//
//   BOWSER_E2E=1 bun test ./tests/e2e-upgrade.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json";
import { maxSessionNameLength } from "../src/state.ts";
import { LOCK } from "../src/commands/restart-lock.ts";
import { killDaemons, daemonPids } from "./helpers/daemons.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

interface Result {
  code: number;
  out: string;
  err: string;
}

runOrSkip("e2e: upgrade without manual restarts (#145)", () => {
  let tmp: string;
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let hits = 0;
  let slow = false;
  const sessions: string[] = [];
  const session = (name: string): string => {
    const s = `up-${name}-${process.pid}`;
    sessions.push(s);
    return s;
  };

  const html = (body: string) =>
    new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });

  /** A copy of this package that reports `version`: an older or newer bowser. */
  async function copyAt(name: string, version: string): Promise<string> {
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    await cp(join(ROOT, "src"), join(dir, "src"), { recursive: true });
    await Bun.write(join(dir, "package.json"), JSON.stringify({ ...pkg, version }, null, 2));
    return join(dir, "src", "cli.ts");
  }

  async function run(cli: string, s: string, args: string[]): Promise<Result> {
    const proc = Bun.spawn([process.execPath, cli, `-s=${s}`, ...args], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out.trim(), err: err.trim() };
  }

  async function ok(cli: string, s: string, args: string[]): Promise<string> {
    const r = await run(cli, s, args);
    if (r.code !== 0) throw new Error(`bowser ${args.join(" ")} exited ${r.code}: ${r.err}`);
    return r.out;
  }

  const notice = (s: string, was: string, rest: string) =>
    `bowser: session '${s}' restarted for bowser ${pkg.version} (was ${was}): ${rest}`;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "bowser-upgrade-"));
    home = join(tmp, "home");
    await mkdir(home);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/hit") {
          hits++;
          return new Response("ok");
        }
        if (path === "/slow" && slow) await Bun.sleep(4000);
        if (path === "/cart") return html(`<title>Cart</title><button onclick="fetch('/hit')">Add</button>`);
        return html("<title>Home</title><h1>Home</h1>");
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    for (const s of sessions) await killDaemons(s);
    server?.stop(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("the restart reopens the page the old daemon shows after a pushState (ET-33, #152)", async () => {
    const old = await copyAt("old-push", "0.0.1");
    const s = session("push");
    await ok(old, s, ["open", `${base}/cart`]);
    await ok(old, s, ["eval", "(history.pushState(null, '', '/moved'), location.href)"]);
    const saved = JSON.parse(await Bun.file(join(home, ".bowser", "sessions", s, "state.json")).text()) as {
      url: string;
    };
    expect(saved.url).toBe(`${base}/cart`);
    const r = await run(CLI, s, ["eval", "location.pathname"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("/moved");
    expect(r.err).toBe(
      notice(
        s,
        "0.0.1",
        `page reloaded at ${base}/moved; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`,
      ),
    );
  });

  test("snapshot restarts an older daemon, reopens the page and says what was lost", async () => {
    const old = await copyAt("old-a", "0.0.1");
    const s = session("snap");
    await ok(old, s, ["open", `${base}/cart`]);
    const r = await run(CLI, s, ["snapshot"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('button "Add"');
    expect(r.err).toBe(
      notice(
        s,
        "0.0.1",
        `page reloaded at ${base}/cart; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`,
      ),
    );
    expect(await daemonPids(s)).toHaveLength(1);
  }, 60_000);

  test("a --profile session keeps its cookie and its profile across two upgrades in a row", async () => {
    const old = await copyAt("old-b", "0.0.1");
    const newer = await copyAt("new-b", "99.0.0");
    const s = session("profile");
    const dir = join(tmp, "profile-b");
    await ok(old, s, ["open", `${base}/`, `--profile=${dir}`]);
    await ok(old, s, ["eval", "document.cookie = 'k=v; max-age=3600'"]);
    const first = await run(CLI, s, ["eval", "document.cookie"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("k=v");
    expect(first.err).not.toContain("cookies and storage were lost");
    const second = await run(newer, s, ["eval", "document.cookie"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("k=v");
    expect(second.err).toContain(`restarted for bowser 99.0.0 (was ${pkg.version})`);
    const state = await Bun.file(join(home, ".bowser", "sessions", s, "state.json")).json();
    expect(state.profile).toBe(dir);
  }, 90_000);

  test("click with a ref from before the upgrade fails after the notice, and clicks nothing", async () => {
    const old = await copyAt("old-c", "0.0.1");
    const s = session("ref");
    await ok(old, s, ["open", `${base}/cart`]);
    const snap = await ok(old, s, ["snapshot"]);
    const ref = /button "Add" \[ref=(e\d+)\]/.exec(snap)![1]!;
    hits = 0;
    const r = await run(CLI, s, ["click", ref]);
    expect(r.code).toBe(1);
    const lines = r.err.split("\n");
    expect(lines[0]).toStartWith(`bowser: session '${s}' restarted`);
    expect(lines[1]).toBe(`bowser: ref '${ref}' is from a page that is no longer loaded; take a new snapshot`);
    await Bun.sleep(300);
    expect(hits).toBe(0);
  }, 60_000);

  for (const [label, lockedBy] of [
    ["", undefined],
    [" with a dead holder's lock left behind", "dead"],
  ] as const) {
    test(`two commands at once restart the session once${label}`, async () => {
      const old = await copyAt(`old-d${lockedBy ?? ""}`, "0.0.1");
      const s = session(`twice${lockedBy ?? ""}`);
      await ok(old, s, ["open", `${base}/`]);
      if (lockedBy) {
        const dead = Bun.spawn(["true"]);
        await dead.exited;
        await Bun.write(join(home, ".bowser", "sessions", s, LOCK), String(dead.pid));
      }
      const [a, b] = await Promise.all([run(CLI, s, ["snapshot"]), run(CLI, s, ["snapshot"])]);
      expect([a.code, b.code]).toEqual([0, 0]);
      expect([a.err, b.err].filter((e) => e.includes("restarted"))).toHaveLength(1);
      expect(await daemonPids(s)).toHaveLength(1);
    }, 60_000);
  }

  test("the longest session name the HOME allows restarts too", async () => {
    const old = await copyAt("old-e", "0.0.1");
    const prev = process.env.HOME;
    process.env.HOME = home;
    const s = "l".repeat(maxSessionNameLength());
    process.env.HOME = prev;
    sessions.push(s);
    await ok(old, s, ["open", `${base}/`]);
    const r = await run(CLI, s, ["snapshot"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("restarted");
  }, 60_000);

  test("a restart whose reload fails leaves no lock, and the next command answers at once", async () => {
    const old = await copyAt("old-f", "0.0.1");
    const gone = Bun.serve({ port: 0, fetch: () => html("<title>Gone</title>") });
    const url = gone.url.toString();
    const s = session("noreload");
    await ok(old, s, ["open", url]);
    gone.stop(true);
    const r = await run(CLI, s, ["eval", "1"]);
    expect(r.err).toContain(`page did not reload at ${url}`);
    expect(existsSync(join(home, ".bowser", "sessions", s, LOCK))).toBe(false);
    const t0 = Date.now();
    await run(CLI, s, ["eval", "1"]);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 60_000);

  test("a first command killed during the reload leaves the notice for the next command (ET-29)", async () => {
    const old = await copyAt("old-g", "0.0.1");
    const s = session("killed");
    slow = false;
    await ok(old, s, ["open", `${base}/slow`]);
    await ok(old, s, ["localstorage-set", "tok", "7"]);
    slow = true;
    try {
      const proc = Bun.spawn([process.execPath, CLI, `-s=${s}`, "localstorage-get", "tok"], {
        env: { ...process.env, HOME: home },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await Bun.sleep(1200);
      proc.kill("SIGKILL");
      await proc.exited;
      const next = await run(CLI, s, ["eval", "1"]);
      expect(next.code).toBe(0);
      expect(next.err).toBe(
        notice(
          s,
          "0.0.1",
          `page reload at ${base}/slow was interrupted; refs cleared, run 'bowser snapshot'; cookies and storage were lost (no --persistent)`,
        ),
      );
      const after = await run(CLI, s, ["eval", "1"]);
      expect(after).toEqual({ code: 0, out: "1", err: "" });
    } finally {
      slow = false;
    }
  }, 60_000);

  test("close during the restart leaves the session closed (ET-32)", async () => {
    const old = await copyAt("old-h", "0.0.1");
    const s = session("closing");
    const dir = join(home, ".bowser", "sessions", s);
    await ok(old, s, ["open", `${base}/`, "--persistent"]);
    const [ev, cl] = await Promise.all([run(CLI, s, ["eval", "1"]), run(CLI, s, ["close"])]);
    expect(cl.code).toBe(0);
    if (ev.code !== 0) {
      expect(ev.err).toMatch(
        new RegExp(
          `was closed while this command waited to restart it|daemon for session '${s}' closed the connection`,
        ),
      );
    }
    expect(await daemonPids(s)).toHaveLength(0);
    expect((await run(CLI, s, ["list"])).out).not.toContain(s);
    expect(["state.json", "pid", "sock"].filter((f) => existsSync(join(dir, f)))).toEqual([]);
  }, 60_000);

  test("a running bowser mcp hands over to the installed version after an upgrade", async () => {
    const cli = await copyAt("old-mcp", "0.0.1");
    const s = session("mcp");
    const proc = Bun.spawn([process.execPath, cli, "mcp"], {
      env: { ...process.env, HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    const lines: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    })();
    const send = (...msgs: object[]) => {
      proc.stdin.write(msgs.map((m) => JSON.stringify(m) + "\n").join(""));
      proc.stdin.flush();
    };
    const answer = async (id: number) => {
      for (let t = 0; t < 600; t++) {
        const hit = lines.map((l) => JSON.parse(l)).find((r) => r.id === id);
        if (hit) return hit;
        await Bun.sleep(100);
      }
      throw new Error(`no answer for id ${id}`);
    };
    const call = (id: number, name: string, args: object) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: { session: s, ...args } },
    });
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await answer(1);
      expect((await answer((send(call(2, "open", { url: `${base}/cart` })), 2))).result.isError).toBeFalsy();
      // A call still running when the version changes answers before anything forwarded.
      send(call(3, "eval", { expression: "new Promise((r) => setTimeout(() => r('slow'), 1500))" }));
      await Bun.sleep(300);
      await Bun.write(join(tmp, "old-mcp", "package.json"), JSON.stringify({ ...pkg, version: "0.0.2" }, null, 2));
      send(call(4, "snapshot", {}), call(5, "snapshot", {}));
      const [three, four, five] = [await answer(3), await answer(4), await answer(5)];
      expect(three.result.content[0].text).toContain("slow");
      const ids = lines.map((l) => JSON.parse(l).id);
      expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(4));
      expect(ids.filter((id) => id === 4 || id === 5)).toHaveLength(2);
      expect(four.result.content[0].text).toStartWith(`session '${s}' restarted for bowser 0.0.2 (was 0.0.1)`);
      expect(five.result.isError).toBeFalsy();
      expect(lines.join("\n")).not.toContain("differs from the installed bowser");
    } finally {
      proc.stdin.end();
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
      proc.kill();
      await reading.catch(() => {});
    }
  }, 120_000);
});
