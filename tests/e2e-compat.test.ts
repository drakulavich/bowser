// Differential test: the same todo flow through playwright-cli (WebKit) and
// bowser (WebKit) against the same fixture. playwright-cli 0.1.x prints the
// full accessibility tree, bowser prints interactive elements only, so the
// assertion is subset, not equality: every (role, name) bowser reports must
// appear in playwright-cli's tree, before and after the flow.
//
// Skips unless BOWSER_E2E=1, on macOS, with playwright-cli in $PATH and its
// WebKit installed (`playwright-cli install-browser webkit`). The describe
// itself is gated at definition time on a cache-directory check, so a missing
// install shows as a real skip in the run summary — that cache-dir gate is
// the only skip. The `pwReady` flag inside is a second backstop for a
// `webkit-*` cache dir that exists but is broken (e.g. corrupt), in which
// case `playwright-cli open` fails at runtime with a warning logged in
// `beforeAll`; from there on a `webkit-*` dir that playwright-cli still
// reports as not installed is a hard failure, not a skip, so each test
// throws instead of returning early.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { cmdClick, cmdClose, cmdFill, cmdOpen, cmdSnapshot, type CommandContext } from "../src/commands.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const PW = Bun.which("playwright-cli");

/** playwright-cli keeps browsers under ~/Library/Caches/ms-playwright/<name>-<build>. */
function playwrightHasWebkit(): boolean {
  const dir = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    return existsSync(dir) && readdirSync(dir).some((d) => d.startsWith("webkit"));
  } catch {
    return false;
  }
}

const runOrSkip = E2E && process.platform === "darwin" && PW && playwrightHasWebkit() ? describe : describe.skip;

type Entry = { role: string; name: string };

/** (role, name) pairs from playwright-cli's yaml fence. Nodes without a
 *  quoted name (generic containers) are ignored. */
function parsePlaywright(stdout: string): Entry[] {
  const m = stdout.match(/```yaml\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no yaml fence in playwright-cli output:\n${stdout}`);
  const out: Entry[] = [];
  for (const line of m[1]!.split("\n")) {
    const r = line.match(/^\s*- (\S+) "([^"]*)"/);
    if (r) out.push({ role: r[1]!, name: r[2]! });
  }
  return out;
}

/** (role, name) pairs for bowser's leaf refs. */
function parseBowser(yaml: string): Entry[] {
  const out: Entry[] = [];
  for (const line of yaml.split("\n")) {
    const r = line.match(/^\s*- (\S+) "([^"]*)": \[ref=e\d+\]/);
    if (r) out.push({ role: r[1]!, name: r[2]! });
  }
  return out;
}

function missingFrom(sub: Entry[], sup: Entry[]): Entry[] {
  const key = (e: Entry) => `${e.role} ${e.name}`;
  const have = new Set(sup.map(key));
  return sub.filter((e) => !have.has(key(e)));
}

runOrSkip("e2e: bowser vs playwright-cli on WebKit", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origBackend: string | undefined;
  let server: { stop: () => void } | undefined;
  let base: string;
  let pwReady = false;

  const session = "compat";
  const ctx: CommandContext = { session, json: true };
  const text: CommandContext = { session, json: false };
  const pwSession = "bowser-compat";

  /** Run playwright-cli in the tmp dir (it writes .playwright-cli/ to cwd). */
  async function pw(...args: string[]): Promise<{ code: number; out: string }> {
    const p = Bun.spawn({
      cmd: [PW!, `-s=${pwSession}`, ...args],
      cwd: tmp,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: origHome ?? process.env.HOME! },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: out + err };
  }

  /** playwright-cli ref for the first node with this role and name. */
  function pwRef(stdout: string, role: string, name: string): string {
    const m = stdout.match(/```yaml\n([\s\S]*?)\n```/);
    const re = new RegExp(`^\\s*- ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\n]*\\[ref=(e\\d+)\\]`, "m");
    const r = (m?.[1] ?? "").match(re);
    if (!r) throw new Error(`playwright-cli: no ${role} "${name}" in:\n${stdout}`);
    return r[1]!;
  }

  async function bowserRef(name: string): Promise<string> {
    const s = await loadState(session);
    const r = s?.refs.find((x) => x.name === name);
    if (!r) throw new Error(`bowser: no ref named ${JSON.stringify(name)}`);
    return r.id;
  }

  beforeAll(async () => {
    origHome = process.env.HOME;
    origBackend = process.env.BOWSER_BACKEND;
    tmp = await mkdtemp(join(tmpdir(), "bowser-compat-"));
    process.env.BOWSER_BACKEND = "webkit";

    const html = await readFile(join(import.meta.dir, "fixtures/todo-app.html"), "utf8");
    const s = Bun.serve({
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    server = { stop: () => s.stop(true) };
    base = s.url.toString();

    // playwright-cli keeps its own daemon; open it with the real HOME (its
    // browser cache lives there) before bowser's HOME is redirected.
    const opened = await pw("open", "--browser=webkit", base);
    if (opened.code !== 0) {
      if (/is not installed/.test(opened.out)) {
        console.warn("e2e-compat: playwright-cli has no WebKit; run `playwright-cli install-browser webkit`. Skipping.");
      } else {
        throw new Error(`playwright-cli open failed:\n${opened.out}`);
      }
    } else {
      pwReady = true;
    }

    process.env.HOME = tmp;
    await cmdOpen(ctx, base);
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    if (pwReady) { try { await pw("close"); } catch {} }
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origBackend === undefined) delete process.env.BOWSER_BACKEND;
    else process.env.BOWSER_BACKEND = origBackend;
    await rm(tmp, { recursive: true, force: true });
  });

  test("bowser's refs are a subset of playwright-cli's tree on the fresh page", async () => {
    if (!pwReady) throw new Error("playwright-cli reported WebKit not installed although a webkit-* cache dir exists; run `playwright-cli install-browser webkit`");
    const pwOut = (await pw("snapshot")).out;
    const bowserOut = await cmdSnapshot(text);
    const missing = missingFrom(parseBowser(bowserOut), parsePlaywright(pwOut));
    expect(missing, `bowser refs absent from playwright-cli:\n${JSON.stringify(missing)}\n\nbowser:\n${bowserOut}\n\nplaywright-cli:\n${pwOut}`).toEqual([]);
  }, 90_000);

  test("after the same fill+click flow both tools see the new todos", async () => {
    if (!pwReady) throw new Error("playwright-cli reported WebKit not installed although a webkit-* cache dir exists; run `playwright-cli install-browser webkit`");
    for (const todo of ["buy milk", "write tests"]) {
      // playwright-cli: re-snapshot before each action, refs can shift.
      let snap = (await pw("snapshot")).out;
      const fill = await pw("fill", pwRef(snap, "textbox", "New todo"), todo);
      expect(fill.code, fill.out).toBe(0);
      snap = (await pw("snapshot")).out;
      const click = await pw("click", pwRef(snap, "button", "Add"));
      expect(click.code, click.out).toBe(0);

      // bowser: same dance.
      await cmdSnapshot(text);
      await cmdFill(ctx, await bowserRef("New todo"), todo);
      await cmdSnapshot(text);
      await cmdClick(ctx, await bowserRef("Add"));
    }

    const pwOut = (await pw("snapshot")).out;
    const bowserOut = await cmdSnapshot(text);
    const b = parseBowser(bowserOut);
    expect(b).toContainEqual({ role: "checkbox", name: "Toggle buy milk" });
    expect(b).toContainEqual({ role: "checkbox", name: "Toggle write tests" });
    const missing = missingFrom(b, parsePlaywright(pwOut));
    expect(missing, `bowser refs absent from playwright-cli:\n${JSON.stringify(missing)}\n\nbowser:\n${bowserOut}\n\nplaywright-cli:\n${pwOut}`).toEqual([]);
  }, 180_000);
});
