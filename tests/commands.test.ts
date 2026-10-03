// Command-layer tests with a fake daemon client. No real browser needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import pkg from "../package.json";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { COMMANDS, findCommand } from "../src/cli/registry.ts";
import { reportFailure, run } from "../src/cli.ts";
import { cmdDialog } from "../src/commands/dialog.ts";
import { readStdin, reply, syncState, type CommandContext } from "../src/commands/context.ts";
import { pidPath, type ConnectOptions } from "../src/daemon/client.ts";
import { looksLikeOurDaemon } from "../src/daemon/pidfile.ts";
import {
  cmdCheck, cmdClick, cmdFill, cmdHover, cmdPress, cmdResize, cmdSelect, cmdType, cmdUncheck,
} from "../src/commands/interaction.ts";
import {
  closeOne, cmdClose, cmdGoto, cmdHistory, cmdList, cmdOpen,
  type ProcessOps,
} from "../src/commands/navigation.ts";
import { cmdEval, cmdRunCode } from "../src/commands/scripting.ts";
import { cmdScreenshot, cmdSnapshot } from "../src/commands/snapshot.ts";
import {
  cmdLocalStorageClear, cmdLocalStorageDelete, cmdLocalStorageGet, cmdLocalStorageList,
  cmdLocalStorageSet, cmdSessionStorageClear, cmdSessionStorageDelete, cmdSessionStorageGet,
  cmdSessionStorageList, cmdSessionStorageSet,
} from "../src/commands/web-storage.ts";
import { ensureSessionDir, maxSessionNameLength, saveState, loadState, sessionDir, sessionsRoot } from "../src/state.ts";
import { longHome } from "./helpers/long-home.ts";
import { fakeClient } from "./helpers/fake-client.ts";
import { lineSocket } from "./helpers/fake-daemon.ts";
import { fillScript, READ_VIEWPORT, resolveRefScript, runCodeScript, storageSetScript } from "../src/page-scripts.ts";
import { UserError } from "../src/errors.ts";
import { usageOf } from "../src/cli/help.ts";

/** An evaluate handler that answers the ref-resolve script the way the page
 *  would: the element's fresh selector, or null when it is gone. Any other
 *  script evaluates to undefined, the fake's default. */
function resolving(live: Record<string, string | null>) {
  return (expr: string): unknown => {
    const id = resolvedId(expr);
    return id !== undefined && id in live ? live[id] : undefined;
  };
}

/** The ref a resolve script looks up, or undefined for any other script. */
function resolvedId(expr: string): string | undefined {
  return /\.byRef\?\.get\("(e\d+)"\)/.exec(expr)?.[1];
}

async function seedRefs() {
  await saveState({
    name: "default",
    url: "https://x",
    title: "X",
    refs: [
      { id: "e1", role: "link",     name: "Home",  tag: "a" },
      { id: "e2", role: "textbox",  name: "Email", tag: "input" },
      { id: "e3", role: "combobox", name: "Color", tag: "select" },
      { id: "e4", role: "checkbox", name: "Agree", tag: "input" },
    ],
    updatedAt: Date.now(),
  });
}

let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-cmdtest-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

let session: string;
beforeEach(() => { session = "s-" + Math.random().toString(36).slice(2, 8); });

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  session,
  json: false,
  ...overrides,
});

describe("open", () => {
  test("navigates and saves state", async () => {
    const c = fakeClient({});
    const out = await cmdOpen({ ...ctx(), connect: async () => c }, "https://x");
    expect(out).toContain("opened https://x");
    expect(c.calls).toContainEqual(["navigate", ["https://x"]]);
  });
  test("--json", async () => {
    const c = fakeClient({});
    const out = await cmdOpen({ ...ctx({ json: true }), connect: async () => c }, "https://x");
    expect(JSON.parse(out)).toEqual({ ok: true, url: "https://x", title: "Fake https://x" });
  });
});

// F28: only `open` may start a daemon on a session whose browser exited;
// connectOrSpawn refuses the rest. `close` never spawns at all.
describe("which commands may replace a browser that exited", () => {
  for (const [argv, reopen] of [
    [["open", "https://x"], true],
    [["open"], true],
    [["goto", "https://x"], false],
    [["eval", "1"], false],
    [["reload"], false],
  ] as const) {
    test(`${argv.join(" ")}: reopen ${reopen}`, async () => {
      const seen: Array<ConnectOptions | undefined> = [];
      await run([...argv], {
        connect: async (_s, opts) => { seen.push(opts); return fakeClient({}); },
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(Boolean(seen[0]?.reopen)).toBe(reopen);
    });
  }
});

describe("open --persistent / --profile", () => {
  /** Run `open` through its registry entry, as the CLI does, with a fake
   *  connector that records the options the daemon would be spawned with. */
  async function openWith(
    flags: Record<string, string | boolean>,
    running: { profile?: string } | "spawned" = "spawned",
  ) {
    const seen: Array<{ spawn?: boolean; profile?: string } | undefined> = [];
    let c = fakeClient({});
    const connect: CommandContext["connect"] = async (_s, opts) => {
      seen.push(opts);
      // A freshly spawned daemon runs with whatever store it was handed.
      const profile = running === "spawned" ? opts?.profile : running.profile;
      c = fakeClient({ state: () => ({ url: "https://x", title: "X", ...(profile ? { profile } : {}) }) });
      return c;
    };
    const out = await findCommand("open")!.run({ ...ctx(), connect }, { positional: ["https://x"], flags });
    return { out, seen, calls: () => c.calls };
  }

  test("--persistent hands the daemon ~/.bowser/profiles/<session>", async () => {
    const { seen } = await openWith({ persistent: true });
    const expected = join(tmp, ".bowser", "profiles", session);
    expect(seen[0]?.profile).toBe(expected);
  });

  test("--profile=rel/dir hands the daemon that directory resolved against the cwd", async () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const { seen } = await openWith({ profile: "rel/dir" });
      const expected = join(process.cwd(), "rel", "dir");
      expect(seen[0]?.profile).toBe(expected);
      expect(isAbsolute(seen[0]!.profile!)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  test("--profile wins over --persistent", async () => {
    const dir = join(tmp, "explicit-profile");
    const { seen } = await openWith({ persistent: true, profile: dir });
    expect(seen[0]?.profile).toBe(dir);
  });

  test("no flag hands the daemon no profile", async () => {
    const { seen, calls } = await openWith({});
    expect(seen[0]?.profile).toBeUndefined();
    expect(calls().map(([op]) => op)).toEqual(["state", "navigate", "state"]);
  });

  test("records the profile the daemon reports, or null for none (#93)", async () => {
    await openWith({ persistent: true });
    expect((await loadState(session))?.profile).toBe(join(tmp, ".bowser", "profiles", session));
    const dir = join(tmp, "recorded-profile");
    await openWith({ profile: dir });
    expect((await loadState(session))?.profile).toBe(dir);
    await openWith({});
    expect((await loadState(session))?.profile).toBeNull();
    // A daemon already running on a store: plain `open` records that store.
    await openWith({}, { profile: dir });
    expect((await loadState(session))?.profile).toBe(dir);
  });

  test("a failed open records the profile of the daemon it started", async () => {
    const previous = join(tmp, "previous-profile");
    const current = join(tmp, "current profile");
    await saveState({ name: session, url: "https://old", title: "Old", refs: [], updatedAt: 1, profile: previous });
    const client = fakeClient({
      state: () => ({ url: "about:blank", title: "", profile: current }),
      navigate: () => { throw new Error("navigation failed"); },
    });
    const connect: CommandContext["connect"] = async () => client;
    const error = await cmdOpen(ctx({ connect }), "https://unreachable.example", {}).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(error?.message).toBe("navigation failed");
    expect((await loadState(session))?.profile).toBe(current);
  });

  test("a failed open on a live session keeps the saved refs", async () => {
    const refs = [{ id: "e3", role: "link", name: "Home", tag: "a" }];
    await saveState({ name: session, url: "https://old", title: "Old", refs, updatedAt: 1, profile: null });
    const client = fakeClient({
      state: () => ({ url: "https://old", title: "Old" }),
      navigate: () => { throw new Error("navigation failed"); },
    });
    const connect: CommandContext["connect"] = async () => client;
    await cmdOpen(ctx({ connect }), "https://unreachable.example", {}).catch(() => {});
    expect((await loadState(session))?.refs).toEqual(refs);
  });

  test("snapshot keeps the recorded profile (#93)", async () => {
    await openWith({ persistent: true });
    const snap = { url: "https://x", title: "X", tree: [], refs: [] };
    await cmdSnapshot({ ...ctx(), connect: async () => fakeClient({ evaluate: () => snap }) }, {});
    expect((await loadState(session))?.profile).toBe(join(tmp, ".bowser", "profiles", session));
  });

  for (const empty of ["", "   "]) {
    test(`--profile=${JSON.stringify(empty)} is a usage error before any daemon is reached`, async () => {
      const err = await openWith({ profile: empty }).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^usage: /);
      expect(err?.message).toContain("--profile");
    });
  }

  test("an empty --profile never reaches the connector", async () => {
    let connected = false;
    const connect: CommandContext["connect"] = async () => { connected = true; return fakeClient({}); };
    await findCommand("open")!.run({ ...ctx(), connect }, { positional: [], flags: { profile: "" } }).catch(() => {});
    expect(connected).toBe(false);
  });

  test("a conflicting --profile leaves no new directory behind", async () => {
    const dir = join(tmp, "never-created-profile");
    await openWith({ profile: dir }, { profile: "/elsewhere" }).catch(() => {});
    expect(existsSync(dir)).toBe(false);
  });

  test("a running daemon with a different store is a usage error, before any navigation", async () => {
    const err = await openWith({ persistent: true }, { profile: "/elsewhere" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `usage: session '${session}' is already open with a different profile; run 'bowser close' first`,
    );
  });

  test("a running ephemeral daemon conflicts with --persistent too", async () => {
    const err = await openWith({ persistent: true }, {}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^usage: session '.*' is already open with a different profile/);
  });

  test("a running daemon with the same store is reused", async () => {
    const expected = join(tmp, ".bowser", "profiles", session);
    const { out } = await openWith({ persistent: true }, { profile: expected });
    expect(out).toContain("opened https://x");
  });

  test("open without flags reuses a running persistent session", async () => {
    const { out } = await openWith({}, { profile: "/some/profile" });
    expect(out).toContain("opened https://x");
  });

  test("the CLI exits 1 on the different-profile error", async () => {
    // A stand-in daemon on the session's real socket: it answers ping, and
    // reports an ephemeral store on state. The real CLI then refuses --persistent.
    await ensureSessionDir(session);
    const listener = Bun.listen({
      unix: join(sessionDir(session), "sock"),
      socket: lineSocket((s, line) => {
        const req = JSON.parse(line) as { id: number; op: string };
        const result = req.op === "state" ? { url: "about:blank", title: "" } : pkg.version;
        s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
      }),
    });
    try {
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "open", "--persistent", "-s", session],
        { env: { ...process.env, HOME: tmp }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(stderr).toContain(`session '${session}' is already open with a different profile; run 'bowser close' first`);
      expect(code).toBe(1);
    } finally {
      listener.stop(true);
    }
  });

  test("a profile directory that cannot be created fails at once with its path and cause", async () => {
    // A regular file where a parent directory should be: mkdir must fail in
    // the CLI, before a daemon is spawned, not as a startup timeout.
    const blocker = join(tmp, `blocker-${session}`);
    await Bun.write(blocker, "not a directory");
    const target = join(blocker, "profile");
    const t0 = Date.now();
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "open", `--profile=${target}`, "-s", session],
      { env: { ...process.env, HOME: tmp }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).toContain(target);
    expect(stderr).toMatch(/ENOTDIR|not a directory/i);
    expect(stderr).not.toContain("did not start in time");
    expect(code).toBe(2);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("close leaves the profile directory in place", async () => {
    await openWith({ persistent: true });
    const profile = join(tmp, ".bowser", "profiles", session);
    await Bun.write(join(profile, "Cookies"), "x");
    await cmdClose({ ...ctx(), connect: async () => fakeClient({}) });
    expect(existsSync(sessionDir(session))).toBe(false);
    expect(await Bun.file(join(profile, "Cookies")).text()).toBe("x");
  });
});

describe("goto", () => {
  test("navigates within current session", async () => {
    const c = fakeClient({});
    const out = await cmdGoto({ ...ctx(), connect: async () => c }, "https://y");
    expect(out).toContain("https://y");
    expect(c.calls).toContainEqual(["navigate", ["https://y"]]);
  });
  test("goto errors when a real URL ends on about:blank", async () => {
    const c = fakeClient({ state: () => ({ url: "about:blank", title: "X" }) });
    await expect(
      cmdGoto({ ...ctx(), connect: async () => c }, "https://example.com/?q=1"),
    ).rejects.toThrow(/did not load/i);
  });
});

// F4 (docs/superpowers/specs/2026-09-27-p1-fixes-design.md): a word past a
// command's declared positionals is an error, not silently dropped.
describe("too many arguments", () => {
  /** A context whose every daemon connection is counted, and refused. */
  function counting() {
    const seen = { connects: 0 };
    const base: Partial<CommandContext> = {
      connect: async () => {
        seen.connects++;
        throw new Error("an arity error must not connect to a daemon");
      },
      readStdin: async () => {
        throw new Error("an arity error must not read stdin");
      },
    };
    return { seen, base };
  }

  for (const c of COMMANDS) {
    const n = c.positional.length;
    test(`${c.name} with ${n + 1} positionals fails with usage:, connects to nothing, exits 1`, async () => {
      const { seen, base } = counting();
      const words = Array.from({ length: n + 1 }, (_, i) => `w${i}`);
      const err = await run(["-s", session, c.name, ...words], base).then(
        () => { throw new Error("expected a failure"); },
        (e: unknown) => e,
      );
      expect((err as Error).message).toBe(
        `usage: too many arguments for '${c.name}': expected ${n}, received ${n + 1}`,
      );
      expect(seen.connects).toBe(0);
      expect(reportFailure(err).code).toBe(1);
    });
  }

  // #60: a missing required positional is a usage error before the command
  // runs. run() used to pass "" for it, so `select e3` and
  // `localstorage-set k` reached the daemon with an empty value.
  for (const c of COMMANDS) {
    const required = c.positional.filter((p) => p.required).length;
    if (required === 0) continue;
    test(`${c.name} with ${required - 1} positionals fails with its usage, connects to nothing, exits 1`, async () => {
      const { seen, base } = counting();
      const words = Array.from({ length: required - 1 }, (_, i) => `w${i}`);
      const err = await run(["-s", session, c.name, ...words], base).then(
        () => { throw new Error("expected a failure"); },
        (e: unknown) => e,
      );
      expect((err as Error).message).toBe(`usage: bowser ${usageOf(c)}`);
      expect(seen.connects).toBe(0);
      expect(reportFailure(err).code).toBe(1);
    });
  }

  test("select e3 and localstorage-set k name their usage", async () => {
    const { base } = counting();
    await expect(run(["-s", session, "select", "e3"], base)).rejects.toThrow("usage: bowser select <ref> <value>");
    await expect(run(["-s", session, "localstorage-set", "k"], base)).rejects.toThrow(
      "usage: bowser localstorage-set <key> <value>",
    );
  });

  // An empty word is a value, as in playwright-cli (measured, 0.1.13):
  // `select e2 ""`, `fill e3 ""` and `localstorage-set k ""` all run there.
  test("an explicitly empty value still runs: select, fill, localstorage-set", async () => {
    await seedRefs();
    const c = fakeClient({ evaluate: resolving({ e2: "input", e3: "select" }), select: () => true });
    const base = { connect: async () => c };
    expect(await run(["select", "e3", ""], base)).toContain(`selected e3 -> ""`);
    expect(c.calls).toContainEqual(["select", ["select", ""]]);
    expect(await run(["fill", "e2", ""], base)).toContain("filled e2");
    expect(await run(["-s", session, "localstorage-set", "k", ""], base)).toContain("set k");
    expect(c.calls).toContainEqual(["evaluate", [storageSetScript("localStorage", "k", "")]]);
  });

  test("words after -- still count: fill e1 -- a b is too many", async () => {
    const { seen, base } = counting();
    await expect(run(["-s", session, "fill", "e1", "--", "a", "b"], base)).rejects.toThrow(
      "usage: too many arguments for 'fill': expected 2, received 3",
    );
    expect(seen.connects).toBe(0);
  });

  test("the declared count still runs: eval with one expression reaches the daemon", async () => {
    const c = fakeClient({ evaluate: () => 2 });
    expect(await run(["-s", session, "eval", "1 + 1"], { connect: async () => c })).toContain("2");
  });

  // The entry starts the MCP server before run() would see the word, so it
  // is spawned as the CLI runs, like the F1 help test.
  test("bowser mcp extra fails with usage: and exit 1, starting no server", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "mcp", "extra"],
      env: { ...process.env, HOME: tmp },
      // A pipe held open: a started MCP server would wait on it forever.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 5_000);
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    expect(stderr.trim()).toBe("bowser: usage: too many arguments for 'mcp': expected 0, received 1");
    expect(code).toBe(1);
  }, 15_000);
});

// F15: a URL without a scheme gets one before the daemon sees it.
describe("URL normalization in open and goto", () => {
  const table: Array<[string, string]> = [
    ["example.com", "https://example.com"],
    ["example.com/path?q=1", "https://example.com/path?q=1"],
    ["example.com:8080", "https://example.com:8080"],
    ["localhost:3000/x", "http://localhost:3000/x"],
    ["localhost", "http://localhost"],
    ["127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["[::1]:3000/a", "http://[::1]:3000/a"],
    ["http://example.com/", "http://example.com/"],
    ["https://localhost:3000/", "https://localhost:3000/"],
    ["about:blank", "about:blank"],
    ["data:text/html,<p>hi</p>", "data:text/html,<p>hi</p>"],
    ["file:///tmp/x.html", "file:///tmp/x.html"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    ["tel:5551234", "tel:5551234"],
  ];
  for (const cmd of ["open", "goto"] as const) {
    for (const [typed, sent] of table) {
      test(`${cmd} ${typed} navigates to ${sent} and replies with it`, async () => {
        const c = fakeClient({});
        const out = await run(["-s", session, cmd, typed], { connect: async () => c });
        expect(c.calls.filter(([op]) => op === "navigate")).toEqual([["navigate", [sent]]]);
        expect(out).toContain(sent);
      });
    }
  }
});

describe("open (assertNavigated guard)", () => {
  test("open errors when a real URL ends on about:blank", async () => {
    const c = fakeClient({ state: () => ({ url: "about:blank", title: "" }) });
    await expect(
      cmdOpen({ ...ctx(), connect: async () => c }, "https://example.com/?q=1"),
    ).rejects.toThrow(/did not load/i);
  });

  test("open does NOT throw when the URL resolves correctly", async () => {
    const c = fakeClient({ state: () => ({ url: "https://example.com/?q=1", title: "T" }) });
    const out = await cmdOpen({ ...ctx(), connect: async () => c }, "https://example.com/?q=1");
    expect(out).toContain("https://example.com/?q=1");
  });
});

describe("snapshot", () => {
  const snap = {
    url: "https://x", title: "X",
    tree: [{ role: "link", name: "Home", ref: "e1", props: { url: "/" }, children: [] }],
    refs: [{ id: "e1", role: "link", name: "Home", tag: "a" }],
  };
  const yaml = "### Page\n- Page URL: https://x\n- Page Title: X\n### Snapshot\n" +
    "```yaml\n- link \"Home\" [ref=e1]:\n  - /url: /\n```";

  test("prints the page wrapper around the aria-tree YAML", async () => {
    const c = fakeClient({ evaluate: () => snap });
    const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, {});
    expect(out).toBe(yaml);
  });
  test("--filename writes the printed text and prints 'wrote <path>'", async () => {
    const file = join(tmp, `snap-${Date.now()}.md`);
    const c = fakeClient({ evaluate: () => snap });
    const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, { filename: file });
    expect(out).toBe(`wrote ${file}`);
    expect(await Bun.file(file).text()).toBe(yaml + "\n");
  });
  test("--filename with a relative path writes under the cwd and reports the absolute path (F37)", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c = fakeClient({ evaluate: () => snap });
      const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, { filename: "snap-rel.md" });
      const abs = join(realpathSync(tmp), "snap-rel.md");
      expect(out).toBe(`wrote ${abs}`);
      expect(await Bun.file(abs).text()).toBe(yaml + "\n");
    } finally {
      process.chdir(origCwd);
    }
  });
  test("--json prints { snapshot: <tree> } only", async () => {
    const c = fakeClient({ evaluate: () => snap });
    const out = await cmdSnapshot({ ...ctx({ json: true }), connect: async () => c }, {});
    expect(JSON.parse(out)).toEqual({ snapshot: '- link "Home" [ref=e1]:\n  - /url: /' });
  });
  // F38: the reply has screenshot's shape, and the file is always the text.
  test("--json --filename answers {ok, filename}; the file holds the ### Page text", async () => {
    const file = join(tmp, `snap-json-${Date.now()}.md`);
    const c = fakeClient({ evaluate: () => snap });
    const out = await cmdSnapshot({ ...ctx({ json: true }), connect: async () => c }, { filename: file });
    expect(JSON.parse(out)).toEqual({ ok: true, filename: file });
    expect(await Bun.file(file).text()).toBe(yaml + "\n");
  });
  test("--json --filename: the dialogs go in the reply, the Modal state lines in the file", async () => {
    const dismissed = { type: "confirm" as const, message: "sure?", state: "dismissed" as const, unanswered: true as const };
    const file = join(tmp, `snap-json-dlg-${Date.now()}.md`);
    const c = fakeClient({ evaluate: () => snap }, { dialogs: [dismissed] });
    const out = await cmdSnapshot({ ...ctx({ json: true }), connect: async () => c }, { filename: file });
    expect(JSON.parse(out)).toEqual({
      ok: true, filename: file, dialogs: [{ type: "confirm", message: "sure?", state: "dismissed" }],
    });
    expect(await Bun.file(file).text()).toContain(
      '### Modal state\n- ["confirm" dialog with message "sure?"]: dismissed (run dialog-accept before the action to accept it)\n### Snapshot',
    );
  });
});

describe("close", () => {
  /** Process facts a test controls. The default refuses to signal anything —
   *  a test that expects a kill must say so. `graceMs` is small so the
   *  give-up path does not spend the real grace period twice. */
  const procOps = (o: Partial<ProcessOps> = {}): ProcessOps => ({
    alive: () => false,
    ours: async () => false,
    term: () => { throw new Error("term must not be called"); },
    graceMs: 20,
    ...o,
  });

  /** A daemon that cannot be reached — the case the whole ticket is about. */
  const unreachable = async () => { throw new Error("no daemon"); };

  test("clears state", async () => {
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c });
    expect(out).toContain(`closed session '${session}'`);
  });

  test("closes the session named by the positional, not --session default", async () => {
    const c = fakeClient({});
    // Seed 'dog1' with non-empty state and leave ctx()'s random session absent.
    await saveState({ name: "dog1", url: "u", title: "t", refs: [], updatedAt: 1 });
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { name: "dog1" });
    expect(out).toContain("closed session 'dog1'");
    // 'dog1' is gone from disk; ctx's session was never touched.
    expect(existsSync(sessionDir("dog1"))).toBe(false);
    expect(await loadState(session)).toBeNull();
  });

  test("removes the session directory", async () => {
    await saveState({ name: session, url: "u", title: "t", refs: [], updatedAt: 1 });
    expect(existsSync(sessionDir(session))).toBe(true);
    await cmdClose({ ...ctx(), connect: async () => fakeClient({}) });
    expect(existsSync(sessionDir(session))).toBe(false);
  });

  test("succeeds on a session that never existed", async () => {
    const out = await closeOne({ ...ctx(), connect: unreachable }, "never-existed", procOps());
    expect(out).toContain("closed session 'never-existed'");
  });

  test("ends an unreachable daemon that is ours", async () => {
    await ensureSessionDir(session);
    await Bun.write(pidPath(session), "4242");
    let termed = false;
    const out = await closeOne({ ...ctx(), connect: unreachable }, session, procOps({
      alive: () => !termed,
      ours: async () => true,
      term: () => { termed = true; },
    }));
    expect(termed).toBe(true);
    expect(out).toContain("ended unreachable daemon 4242");
    expect(existsSync(sessionDir(session))).toBe(false);
  });

  test("never signals, nor writes off, a live pid it cannot identify", async () => {
    await ensureSessionDir(session);
    await Bun.write(pidPath(session), "4242");
    // procOps()'s term throws, so reaching it fails the test rather than
    // quietly killing a stranger. Nor may close assume the number was reused
    // and report the session closed: that is the same lie in a smaller case.
    const call = closeOne({ ...ctx(), connect: unreachable }, session, procOps({
      alive: () => true,
    }));
    await expect(call).rejects.toThrow(/does not look like a bowser daemon/);
    expect(existsSync(sessionDir(session))).toBe(true);
  });

  test("refuses to delete a session that was reopened while closing", async () => {
    await ensureSessionDir(session);
    await Bun.write(pidPath(session), "4242");
    // The daemon acknowledges the shutdown, and a concurrent `open` starts a
    // replacement before the directory is removed. Deleting it now would take
    // the newcomer's socket with it and orphan the very process this command
    // exists to end.
    const replaced = fakeClient({
      shutdown: async () => { await Bun.write(pidPath(session), "9999"); },
    });
    const call = closeOne({ ...ctx(), connect: async () => replaced }, session, procOps({
      alive: (pid) => pid === 9999,
    }));
    await expect(call).rejects.toThrow(/reopened while closing \(pid 9999\)/);
    expect(existsSync(sessionDir(session))).toBe(true);
  });

  test("fails, and keeps the directory, when the daemon will not die", async () => {
    await ensureSessionDir(session);
    await Bun.write(pidPath(session), "4242");
    const call = closeOne({ ...ctx(), connect: unreachable }, session, procOps({
      alive: () => true,
      ours: async () => true,
      term: () => {},
    }));
    await expect(call).rejects.toThrow(/pid 4242.*still running/);
    expect(existsSync(sessionDir(session))).toBe(true);
  });

  test("refuses a session name that escapes the sessions root", async () => {
    // Before the directory was removed recursively this name only misplaced a
    // state file. `bowser -s ../../Documents close` must not resolve outside
    // ~/.bowser/sessions, let alone delete what it finds there.
    const victim = join(tmp, "victim");
    await mkdir(victim, { recursive: true });
    const call = cmdClose({ ...ctx(), connect: unreachable }, { name: "../../victim" });
    await expect(call).rejects.toThrow(/session name/);
    expect(existsSync(victim)).toBe(true);
  });

  test("refuses a session name with spaces or a leading dash", () => {
    // `ps` prints a display line, not argv. A session named `--daemon victim`
    // would run as `bowser --daemon --daemon victim`, which reads exactly like
    // the daemon for `victim`, and `close victim` could then signal it.
    for (const name of ["--daemon victim", "team one", "-x"]) {
      expect(() => sessionDir(name)).toThrow(/session name/);
    }
  });

  // Names made before the naming rule existed still sit under the sessions
  // root. `sessionDir` refuses them, and so did `close --all`, leaving them
  // behind forever.
  test("--all removes a directory whose name predates the naming rule", async () => {
    const legacy = join(tmp, ".bowser", "sessions", " m11-1 m12-2");
    await mkdir(legacy, { recursive: true });
    const out = await cmdClose({ ...ctx(), connect: unreachable }, { all: true });
    expect(out).toContain(" m11-1 m12-2");
    expect(out).not.toContain("failed");
    expect(existsSync(legacy)).toBe(false);
  });

  // F35: a directory whose name is now too long for this HOME (left by an
  // older bowser, whose daemon could not claim it) is still listed as dead,
  // and close and close --all still remove it.
  test("close, list and close --all handle a directory whose name is too long for this HOME", async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = await longHome(tmp, 900);
    try {
      const name = "n".repeat(maxSessionNameLength() + 5);
      const dir = join(sessionsRoot(), name);
      await mkdir(dir);
      expect(await cmdList({ ...ctx({ json: true }), connect: unreachable })).toBe("[]");
      expect(await cmdClose({ ...ctx(), connect: unreachable }, { name })).toBe(`closed session '${name}'`);
      expect(existsSync(dir)).toBe(false);
      await mkdir(dir);
      expect(await cmdClose({ ...ctx(), connect: unreachable }, { all: true })).toBe(`closed 1 session: ${name}`);
      expect(existsSync(dir)).toBe(false);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("--all keeps a legacy directory whose recorded pid is alive", async () => {
    // Its daemon can no longer be identified by name, so it is never signalled
    // and its directory stays for a person to deal with.
    const legacy = join(tmp, ".bowser", "sessions", "team one");
    await mkdir(legacy, { recursive: true });
    await Bun.write(join(legacy, "pid"), String(process.pid));
    try {
      const call = cmdClose({ ...ctx(), connect: unreachable }, { all: true });
      await expect(call).rejects.toThrow(`- team one: close: pid ${process.pid} recorded for legacy session "team one" is running`);
      expect(existsSync(legacy)).toBe(true);
    } finally {
      await rm(legacy, { recursive: true, force: true }); // or every later --all sees it fail
    }
  });

  test("--all keeps a legacy directory with an unaccounted socket", async () => {
    const legacy = join(tmp, ".bowser", "sessions", "old session");
    await mkdir(legacy, { recursive: true });
    await Bun.write(join(legacy, "sock"), "");
    try {
      const call = cmdClose({ ...ctx(), connect: unreachable }, { all: true });
      await expect(call).rejects.toThrow('- old session: close: legacy session "old session" has no pidfile but still has a socket');
      expect(existsSync(legacy)).toBe(true);
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  });

  // F31: a session --all could not close fails the command, exit 2, as a
  // single `close` of it does; the rest are still tried and listed.
  test("--all with a session that fails: tries every session, names the reason, exits 2", async () => {
    await saveState({ name: "ok31", url: "x", title: "", refs: [], updatedAt: Date.now() });
    await saveState({ name: "zz31", url: "x", title: "", refs: [], updatedAt: Date.now() });
    await ensureSessionDir("stale31");
    await Bun.write(pidPath("stale31"), "4242");
    const proc = procOps({ alive: (pid) => pid === 4242 });
    try {
      for (const json of [false, true]) {
        if (!existsSync(sessionDir("zz31"))) await saveState({ name: "zz31", url: "x", title: "", refs: [], updatedAt: Date.now() });
        const err = await cmdClose({ ...ctx({ json }), connect: async () => fakeClient({}) }, { all: true }, proc)
          .then(() => undefined, (e: unknown) => e);
        const msg = (err as Error).message;
        // Under --json too: an error is plain text on stderr, like every other.
        expect(msg).toContain("- stale31: close: pid 4242 recorded for session 'stale31' is running but does not look like a bowser daemon");
        // Other tests' sessions share this HOME, so only ours are checked.
        expect(msg).toMatch(/^close --all: closed \d+ sessions?: [^\n]*\bzz31\b/);
        if (!json) expect(msg).toMatch(/^close --all: closed [^\n]*\bok31\b/);
        expect(reportFailure(err).code).toBe(2);
        expect(existsSync(sessionDir("zz31"))).toBe(false);
        expect(existsSync(sessionDir("stale31"))).toBe(true);
      }
    } finally {
      await rm(sessionDir("stale31"), { recursive: true, force: true }); // or every later --all fails
    }
  });

  test("--all closes every session under the sessions root", async () => {
    // Seed two sessions on disk (saveState creates ~/.bowser/sessions/<name>/).
    await saveState({ name: "a", url: "x", title: "", refs: [], updatedAt: Date.now() });
    await saveState({ name: "b", url: "y", title: "", refs: [], updatedAt: Date.now() });
    const c = fakeClient({});
    const out = await cmdClose({ ...ctx(), connect: async () => c }, { all: true });
    expect(out).toMatch(/^closed \d+ sessions?: /);
    expect(out).toContain("a");
    expect(out).toContain("b");
    // and left nothing behind
    expect(existsSync(sessionDir("a"))).toBe(false);
    expect(existsSync(sessionDir("b"))).toBe(false);
  });
});

// The one check standing between a stale pidfile and a signal sent to an
// unrelated process. Refusals first: an over-eager match is the damaging
// direction, and a missed one only leaks a daemon of ours.
describe("looksLikeOurDaemon", () => {
  test("refuses a pid that no longer exists (ps prints nothing)", () => {
    expect(looksLikeOurDaemon("", "sess")).toBe(false);
  });
  test("refuses a process that is not a daemon", () => {
    expect(looksLikeOurDaemon("bun test tests/commands.test.ts sess", "sess")).toBe(false);
  });
  test("refuses a stranger that happens to take --daemon and the same name", () => {
    expect(looksLikeOurDaemon("other-service --daemon sess", "sess")).toBe(false);
  });
  test("refuses a session name that is not the marker's own argument", () => {
    expect(looksLikeOurDaemon("bun /b/src/daemon/main.ts other sess", "sess")).toBe(false);
  });
  test("refuses an unrelated executable or daemon path", () => {
    expect(looksLikeOurDaemon("/usr/local/bin/not-bowser-helper --daemon sess", "sess")).toBe(false);
    expect(looksLikeOurDaemon(`${process.execPath} /tmp/daemon/main.ts sess`, "sess")).toBe(false);
    expect(looksLikeOurDaemon(`${process.execPath} /tmp/not-bowser-helper --daemon sess`, "sess")).toBe(false);
  });
  test("refuses a daemon serving a different session", () => {
    expect(looksLikeOurDaemon("bun /b/src/daemon/main.ts other", "sess")).toBe(false);
  });
  test("refuses a session name that is only a substring of an argument", () => {
    expect(looksLikeOurDaemon("bun /b/src/daemon/main.ts abc", "ab")).toBe(false);
  });
  test("accepts the source form", () => {
    const main = new URL("../src/daemon/main.ts", import.meta.url).pathname;
    expect(looksLikeOurDaemon(`${process.execPath} ${main} sess`, "sess")).toBe(true);
  });
  test("accepts the compiled form", () => {
    expect(looksLikeOurDaemon("/usr/local/bin/bowser --daemon sess", "sess")).toBe(true);
    expect(looksLikeOurDaemon(`/different/Cellar/bowser/9.9.9/bin/bowser --daemon sess`, "sess")).toBe(true);
    // Release assets keep their platform suffix unless the user renames them.
    expect(looksLikeOurDaemon("/Users/x/Downloads/bowser-macos-arm64 --daemon sess", "sess")).toBe(true);
  });
});

describe("list", () => {
  /** Session directories on disk, one live and two not. */
  async function seedSessions(): Promise<void> {
    for (const n of ["live-a", "dead-b", "dead-c"]) await ensureSessionDir(n);
  }

  /** A connector that answers only for the sessions named. */
  const only = (live: string[]) => async (session: string) => {
    if (!live.includes(session)) throw new Error("connect: no daemon");
    return fakeClient({});
  };

  test("returns string output (sessions or empty)", async () => {
    const out = await cmdList(ctx());
    expect(typeof out).toBe("string");
  });

  test("omits a session whose daemon does not answer", async () => {
    await seedSessions();
    const out = await cmdList({ ...ctx(), connect: only(["live-a"]) });
    expect(out.split("\n").filter(Boolean).sort()).toEqual(["live-a"]);
  });

  test("includes every session whose daemon answers", async () => {
    await seedSessions();
    const out = await cmdList({ ...ctx(), connect: only(["live-a", "dead-c"]) });
    expect(out.split("\n").filter(Boolean).sort()).toEqual(["dead-c", "live-a"]);
  });

  test("--json carries the same filtered set", async () => {
    await seedSessions();
    const out = await cmdList({ ...ctx(), json: true, connect: only(["live-a"]) });
    expect(JSON.parse(out)).toEqual(["live-a"]);
  });
});

describe("cmdClick", () => {
  test("resolves ref and clicks selector", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        tree: [],
        refs: [
          { id: "e1", role: "button", name: "Go", tag: "button" },
        ],
      }),
    });
    // Use cmdSnapshot (new name) for setup
    await cmdSnapshot({ ...ctx(), connect: async () => snapC }, {});

    let clicked: string | undefined;
    const clickC = fakeClient({ click: (s) => { clicked = s; }, evaluate: resolving({ e1: "html > body > button" }) });
    const out = await cmdClick(
      { ...ctx({ json: true }), connect: async () => clickC },
      "e1",
    );
    expect(clicked).toBe("html > body > button");
    expect(JSON.parse(out).ref).toBe("e1");
  });

  test("unknown ref throws helpful error", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    await expect(cmdClick({ ...ctx() }, "e99")).rejects.toThrow(/not found/);
  });
});

describe("cmdFill", () => {
  test("clicks, clears, and types", async () => {
    await cmdOpen(
      { ...ctx(), connect: async () => fakeClient({}) },
      "https://example.com",
    );
    const snapC = fakeClient({
      evaluate: () => ({
        url: "https://example.com/",
        title: "Example",
        tree: [],
        refs: [
          { id: "e1", role: "textbox", name: "Email", tag: "input" },
        ],
      }),
    });
    await cmdSnapshot({ ...ctx(), connect: async () => snapC }, {});

    let clicked = false;
    let typed: string | undefined;
    const fillC = fakeClient({
      click: () => { clicked = true; },
      type: (t) => { typed = t; },
      evaluate: resolving({ e1: "html > body > input" }),
    });
    await cmdFill(
      { ...ctx({ json: true }), connect: async () => fillC },
      "e1",
      "bun@bowser.dev",
    );
    expect(clicked).toBe(true);
    expect(typed).toBe("bun@bowser.dev");
  });
});

// Wave-2 action command tests — use the shared tmp HOME from beforeAll above.
// seedRefs() writes to session "default"; each test uses its own session via ctx()
// which has its own random session name — we seed "default" just to satisfy
// loadState for the ref-lookup tests (those commands load state by ctx.session,
// so we need to seed the right session name).

describe("click", () => {
  test("dispatches click on selector", async () => {
    // Seed state for the current session so resolveRef works.
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e1", role: "link", name: "Home", tag: "a" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e1: "a" }) });
    const out = await cmdClick({ ...ctx(), connect: async () => c }, "e1");
    expect(out).toContain("clicked e1");
    expect(c.calls).toContainEqual(["click", ["a"]]);
  });
});

describe("--json of every ref command names the element (#117)", () => {
  const REFS = [
    { id: "e1", role: "link", name: "Home", tag: "a" },
    { id: "e2", role: "textbox", name: "Email", tag: "input" },
    { id: "e3", role: "combobox", name: "Color", tag: "select" },
    { id: "e4", role: "checkbox", name: "Agree", tag: "input" },
  ];
  for (const [argv, expected] of [
    [["click", "e1"], { ok: true, ref: "e1", element: { role: "link", name: "Home" }, url: "" }],
    [["fill", "e2", "hi"], { ok: true, ref: "e2", element: { role: "textbox", name: "Email" } }],
    [["hover", "e1"], { ok: true, ref: "e1", element: { role: "link", name: "Home" } }],
    [["select", "e3", "red"], { ok: true, ref: "e3", element: { role: "combobox", name: "Color" }, value: "red" }],
    [["check", "e4"], { ok: true, ref: "e4", element: { role: "checkbox", name: "Agree" } }],
    [["uncheck", "e4"], { ok: true, ref: "e4", element: { role: "checkbox", name: "Agree" } }],
  ] as const) {
    test(`bowser --json ${argv.join(" ")}`, async () => {
      await saveState({ name: session, url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() });
      const c = fakeClient({ evaluate: () => "sel" });
      const out = await run(["-s", session, "--json", ...argv], { connect: async () => c });
      expect(JSON.parse(out)).toEqual(expected);
    });
  }
});

describe("fill", () => {
  test("clicks, clears, types", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e2", role: "textbox", name: "Email", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e2: "input" }) });
    await cmdFill({ ...ctx(), connect: async () => c }, "e2", "hi");
    const ops = c.calls.map((cl) => cl[0]);
    expect(ops).toEqual(["resolve", "click", "evaluate", "type"]);
  });

  // F13, F14: the page script fill already sends reports what it found; the
  // command refuses or skips the typing from that answer alone.
  const SECRET = "tomorrow-S3cr3t";
  const answering = (answer: unknown) => {
    const resolve = resolving({ e2: "input" });
    return (expr: string): unknown => resolvedId(expr) === "e2" ? resolve(expr) : answer;
  };
  const fillWith = async (answer: unknown, text = SECRET) => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e2", role: "textbox", name: "Email", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: answering(answer) });
    const result = await cmdFill({ ...ctx(), connect: async () => c }, "e2", text).then(
      (out) => ({ out, err: undefined }),
      (err: Error) => ({ out: undefined, err }),
    );
    return { ...result, ops: c.calls.map((cl) => cl[0]) };
  };

  for (const why of ["disabled", "readonly"] as const) {
    test(`a ${why} element is refused before typing, exit 1`, async () => {
      const { err, ops } = await fillWith({ outcome: why, type: "text" });
      expect(err?.message).toBe(`ref 'e2' is not an editable element (${why})`);
      expect(reportFailure(err).code).toBe(1);
      expect(ops).toEqual(["resolve", "click", "evaluate"]);
    });
  }

  test("text that is not a number is refused on type=number, exit 1, without the text", async () => {
    const { err, ops } = await fillWith({ outcome: "nan", type: "number" });
    expect(err?.message).toBe("ref 'e2' needs a number (input[type=number])");
    expect(reportFailure(err).code).toBe(1);
    expect(ops).not.toContain("type");
  });

  test("a value a date-like input does not keep is refused, exit 1, without the text", async () => {
    const { err, ops } = await fillWith({ outcome: "rejected", type: "date" });
    expect(err?.message).toBe("ref 'e2' did not accept the value for input[type=date]");
    expect(err?.message).not.toContain(SECRET);
    expect(reportFailure(err).code).toBe(1);
    expect(ops).not.toContain("type");
  });

  test("a value the page set itself is not typed again", async () => {
    const { out, ops } = await fillWith({ outcome: "set", type: "date" }, "2024-01-02");
    expect(out).toBe('filled e2 (textbox "Email")');
    expect(ops).toEqual(["resolve", "click", "evaluate"]);
  });

  test("the page script carries the text, and its failure does not echo it", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e2", role: "textbox", name: "Email", tag: "input" }],
      updatedAt: Date.now(),
    });
    const resolve = resolving({ e2: "input" });
    const c = fakeClient({
      evaluate: (expr) => {
        if (resolvedId(expr) === "e2") return resolve(expr);
        throw new Error(`evaluate failed: ${expr}`);
      },
    });
    const err = await cmdFill({ ...ctx(), connect: async () => c }, "e2", SECRET).catch((e: Error) => e);
    expect(c.calls).toContainEqual(["evaluate", [fillScript("input", SECRET)]]);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("type", () => {
  test("types into focused element", async () => {
    const c = fakeClient({});
    await cmdType({ ...ctx(), connect: async () => c }, "abc");
    expect(c.calls).toContainEqual(["type", ["abc"]]);
  });

  const SECRET = "hunter2-S3cr3t!";

  test("the plain answer counts characters and does not echo the text", async () => {
    const out = await cmdType({ ...ctx(), connect: async () => fakeClient({}) }, SECRET);
    expect(out).toBe(`typed ${[...SECRET].length} characters`);
    expect(out).not.toContain(SECRET);
  });

  test("one character is singular", async () => {
    expect(await cmdType({ ...ctx(), connect: async () => fakeClient({}) }, "x")).toBe("typed 1 character");
  });

  test("the count is code points, not UTF-16 units", async () => {
    // "👍" is one code point and two UTF-16 units.
    expect(await cmdType({ ...ctx(), connect: async () => fakeClient({}) }, "👍")).toBe("typed 1 character");
    expect(await cmdType({ ...ctx(), connect: async () => fakeClient({}) }, "a👍")).toBe("typed 2 characters");
  });

  test("the --json answer has a length and no text", async () => {
    const out = await cmdType({ ...ctx({ json: true }), connect: async () => fakeClient({}) }, "a👍");
    expect(JSON.parse(out)).toEqual({ ok: true, length: 2 });
    const secret = await cmdType({ ...ctx({ json: true }), connect: async () => fakeClient({}) }, SECRET);
    expect(secret).not.toContain(SECRET);
  });

  test("a failed type does not put the text in the error", async () => {
    const c = fakeClient({ type: () => { throw new Error("operation 'type' timed out after 30000ms"); } });
    const err = await cmdType({ ...ctx(), connect: async () => c }, SECRET).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("press", () => {
  test("presses a key", async () => {
    const c = fakeClient({});
    await cmdPress({ ...ctx(), connect: async () => c }, "Enter");
    expect(c.calls).toContainEqual(["press", ["Enter"]]);
  });

  // #55: playwright-cli's key combinations. The key goes to the daemon with
  // its modifiers, ControlOrMeta as Meta (bowser runs on macOS only).
  for (const [input, sent] of [
    ["Shift+Tab", ["Tab", ["Shift"]]],
    ["Control+a", ["a", ["Control"]]],
    ["Meta+ArrowLeft", ["ArrowLeft", ["Meta"]]],
    ["ControlOrMeta+a", ["a", ["Meta"]]],
    ["Shift+Meta+z", ["z", ["Shift", "Meta"]]],
    ["Control+Alt+Shift+Meta+Tab", ["Tab", ["Control", "Alt", "Shift", "Meta"]]],
    ["Shift++", ["+", ["Shift"]]],
    ["+", ["+"]],
    ["Enter", ["Enter"]],
  ] as const) {
    test(`${input} is sent as ${JSON.stringify(sent)}`, async () => {
      const c = fakeClient({});
      const out = await cmdPress({ ...ctx(), connect: async () => c }, input);
      expect(c.calls.filter(([op]) => op === "press")).toEqual([["press", sent as unknown as unknown[]]]);
      expect(out).toContain(`pressed ${input}`);
    });
  }

  for (const [input, message] of [
    ["shift+Tab", `usage: bowser press: unknown modifier 'shift' in 'shift+Tab'; use Shift, Control, Alt, Meta or ControlOrMeta`],
    ["Cmd+a", `usage: bowser press: unknown modifier 'Cmd' in 'Cmd+a'; use Shift, Control, Alt, Meta or ControlOrMeta`],
    ["Shift+Shift+a", `usage: bowser press: modifier 'Shift' repeated in 'Shift+Shift+a'`],
    ["F1", `usage: bowser press: WebKit cannot press 'F1'; use one character or Enter, Tab, Space, Backspace, Delete, Escape, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Home, End, PageUp or PageDown`],
    ["Shift", `usage: bowser press: WebKit cannot press 'Shift'; use one character or Enter, Tab, Space, Backspace, Delete, Escape, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Home, End, PageUp or PageDown`],
    ["Control+", `usage: bowser press: WebKit cannot press ''; use one character or Enter, Tab, Space, Backspace, Delete, Escape, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Home, End, PageUp or PageDown`],
  ] as const) {
    test(`${input} is a usage error that reaches no daemon`, async () => {
      let connects = 0;
      const err = await cmdPress({ ...ctx(), connect: async () => { connects++; return fakeClient({}); } }, input).then(
        () => { throw new Error("expected a failure"); },
        (e: unknown) => e as Error,
      );
      expect(err.message).toBe(message);
      expect(reportFailure(err).code).toBe(1);
      expect(connects).toBe(0);
    });
  }
});

describe("hover", () => {
  test("hovers a ref", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e1", role: "link", name: "Home", tag: "a" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e1: "a" }) });
    await cmdHover({ ...ctx(), connect: async () => c }, "e1");
    expect(c.calls).toContainEqual(["hover", ["a"]]);
  });
});

describe("select", () => {
  test("selects a value", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e3", role: "combobox", name: "Color", tag: "select" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e3: "select" }) });
    await cmdSelect({ ...ctx(), connect: async () => c }, "e3", "red");
    expect(c.calls).toContainEqual(["select", ["select", "red"]]);
  });

  // F12: the page answers false when no option's value or label is the text.
  test("no matching option fails at once with exit 1", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e3", role: "combobox", name: "Color", tag: "select" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e3: "select" }), select: () => false });
    const err = await cmdSelect({ ...ctx(), connect: async () => c }, "e3", "nosuch").catch((e: Error) => e);
    expect((err as Error).message).toBe(`ref 'e3' has no option "nosuch"`);
    expect(reportFailure(err).code).toBe(1);
  });
});

describe("check / uncheck", () => {
  test("check sends check op", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e4", role: "checkbox", name: "Agree", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e4: "input.cb" }) });
    await cmdCheck({ ...ctx(), connect: async () => c }, "e4");
    expect(c.calls).toContainEqual(["check", ["input.cb"]]);
  });
  test("uncheck sends uncheck op", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e4", role: "checkbox", name: "Agree", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e4: "input.cb" }) });
    await cmdUncheck({ ...ctx(), connect: async () => c }, "e4");
    expect(c.calls).toContainEqual(["uncheck", ["input.cb"]]);
  });
});

describe("F20: click, check and uncheck refuse a disabled element and uncheck a checked radio", () => {
  const REFS = [
    { id: "e1", role: "button",   name: "Go",    tag: "button" },
    { id: "e4", role: "checkbox", name: "Agree", tag: "input" },
    { id: "e5", role: "radio",    name: "Large", tag: "input" },
  ];
  beforeEach(async () => {
    await saveState({ name: session, url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() });
  });

  for (const [name, ref, run, hit] of [
    ["click", "e1", (x: CommandContext) => cmdClick(x, "e1"), true],
    ["check", "e4", (x: CommandContext) => cmdCheck(x, "e4"), false],
    ["uncheck", "e4", (x: CommandContext) => cmdUncheck(x, "e4"), false],
  ] as const) {
    const resolve = resolveRefScript(REFS.find((r) => r.id === ref)!, { enabled: true, ...(hit ? { hit } : {}) });
    test(`${name} on a disabled element: exit 1, and the resolve is the only request`, async () => {
      const c = fakeClient({ evaluate: (expr) => (expr === resolve ? { disabled: true } : undefined) });
      const err = await run({ ...ctx(), connect: async () => c }).then(
        (out) => { throw new Error(`expected a failure, got ${out}`); },
        (e: Error) => e,
      );
      expect(err.message).toBe(`ref '${ref}' is disabled`);
      expect(reportFailure(err).code).toBe(1);
      expect(c.calls).toEqual([["resolve", [resolve]]]);
    });
  }

  test("uncheck on a checked radio: exit 1 with playwright-cli's advice", async () => {
    const c = fakeClient({ evaluate: resolving({ e5: "input.r" }), uncheck: () => false });
    const err = await cmdUncheck({ ...ctx(), connect: async () => c }, "e5").then(
      (out) => { throw new Error(`expected a failure, got ${out}`); },
      (e: Error) => e,
    );
    expect(err.message).toBe("ref 'e5' is a radio button; select another option in its group to uncheck it");
    expect(reportFailure(err).code).toBe(1);
    expect(c.calls.map(([op]) => op)).toEqual(["resolve", "uncheck"]);
  });

  test("uncheck the page accepts (an unchecked radio included) succeeds", async () => {
    const c = fakeClient({ evaluate: resolving({ e5: "input.r" }), uncheck: () => true });
    expect(await cmdUncheck({ ...ctx(), connect: async () => c }, "e5")).toBe("unchecked e5");
  });
});

describe("actions refuse a ref of the wrong kind", () => {
  // One ref per kind the spec (§5) names, plus non-interactive ones that full-tree
  // snapshots now give refs to.
  const REFS = [
    { id: "e1",  role: "listitem",         name: "",       tag: "li" },
    { id: "e2",  role: "checkbox",         name: "Agree",  tag: "input" },
    { id: "e3",  role: "radio",            name: "Red",    tag: "input" },
    { id: "e4",  role: "switch",           name: "Dark",   tag: "button" },
    { id: "e5",  role: "menuitemcheckbox", name: "Bold",   tag: "div" },
    { id: "e6",  role: "menuitemradio",    name: "Left",   tag: "div" },
    { id: "e7",  role: "combobox",         name: "Color",  tag: "select" },
    { id: "e8",  role: "textbox",          name: "Email",  tag: "input" },
    { id: "e9",  role: "textbox",          name: "Notes",  tag: "textarea" },
    { id: "e10", role: "searchbox",        name: "Search", tag: "input" },
    { id: "e11", role: "spinbutton",       name: "Qty",    tag: "input" },
    { id: "e12", role: "combobox",         name: "City",   tag: "input" },
    { id: "e13", role: "generic",          name: "",       tag: "div", editable: true },
    { id: "e14", role: "paragraph",        name: "",       tag: "p" },
  ];
  // The selector the page answers for each ref, as liveSelector resolves it.
  const LIVE: Record<string, string> = {
    e1: "li",
    e2: "input.cb",
    e3: "input.r",
    e4: "button.s",
    e5: "div.mc",
    e6: "div.mr",
    e7: "select",
    e8: "input.t",
    e9: "textarea",
    e10: "input.q",
    e11: "input.n",
    e12: "input.l",
    e13: "div.ce",
    e14: "p",
  };

  let connected: boolean;
  let c: ReturnType<typeof fakeClient>;
  const actx = () => ({ ...ctx(), connect: async () => { connected = true; return c; } });

  beforeEach(async () => {
    connected = false;
    c = fakeClient({ evaluate: resolving(LIVE) });
    await saveState({ name: session, url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() });
  });

  const rejects = async (p: Promise<string>, message: string) => {
    await expect(p).rejects.toThrow(message);
    expect(connected).toBe(false);
    expect(c.calls).toEqual([]);
  };

  test("check refuses a listitem and a textbox, sending nothing", async () => {
    await rejects(cmdCheck(actx(), "e1"), "ref 'e1' is not a checkbox or radio button (listitem)");
    await rejects(cmdCheck(actx(), "e8"), "ref 'e8' is not a checkbox or radio button (textbox)");
  });

  test("uncheck refuses a paragraph, sending nothing", async () => {
    await rejects(cmdUncheck(actx(), "e14"), "ref 'e14' is not a checkbox or radio button (paragraph)");
  });

  test("select refuses a non-<select> combobox and a listitem, sending nothing", async () => {
    await rejects(cmdSelect(actx(), "e12", "Paris"), "ref 'e12' is not a <select> element (combobox)");
    await rejects(cmdSelect(actx(), "e1", "x"), "ref 'e1' is not a <select> element (listitem)");
  });

  test("fill refuses a listitem, a <select> and a checkbox, sending nothing", async () => {
    const msg = (id: string, role: string) =>
      `ref '${id}' is not an <input>, <textarea> or contenteditable element (${role})`;
    await rejects(cmdFill(actx(), "e1", "x"), msg("e1", "listitem"));
    await rejects(cmdFill(actx(), "e7", "x"), msg("e7", "combobox"));
    await rejects(cmdFill(actx(), "e2", "x"), msg("e2", "checkbox"));
    await rejects(cmdFill(actx(), "e14", "x"), msg("e14", "paragraph"));
  });

  test("check and uncheck accept checkbox, radio, switch, menuitemcheckbox, menuitemradio", async () => {
    for (const id of ["e2", "e3", "e4", "e5", "e6"]) {
      const sel = LIVE[id]!;
      await cmdCheck(actx(), id);
      await cmdUncheck(actx(), id);
      expect(c.calls).toContainEqual(["check", [sel]]);
      expect(c.calls).toContainEqual(["uncheck", [sel]]);
    }
  });

  test("select accepts a <select>", async () => {
    await cmdSelect(actx(), "e7", "red");
    expect(c.calls).toContainEqual(["select", ["select", "red"]]);
  });

  test("fill accepts textbox, textarea, searchbox, spinbutton, input combobox and contenteditable", async () => {
    for (const id of ["e8", "e9", "e10", "e11", "e12", "e13"]) {
      await cmdFill(actx(), id, "hi");
    }
    expect(c.calls.filter(([op]) => op === "type")).toHaveLength(6);
  });

  test("the CLI exits 1 on a wrong-kind ref", async () => {
    const home = await mkdtemp(join(tmpdir(), "bowser-kind-"));
    const prevHome = process.env.HOME;
    const inHome = async <T>(fn: () => Promise<T>): Promise<T> => {
      process.env.HOME = home;
      try { return await fn(); } finally { process.env.HOME = prevHome; }
    };
    try {
      await inHome(() => saveState({ name: "kind", url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() }));
      const p = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", "kind", "check", "e1"],
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      expect(stderr).toContain("ref 'e1' is not a checkbox or radio button (listitem)");
      expect(code).toBe(1);
    } finally {
      // Without the guard the CLI spawns a real daemon; do not leave it running.
      const pid = Number(await inHome(() => Bun.file(pidPath("kind")).text()).catch(() => ""));
      if (pid > 0) try { process.kill(pid); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ref commands resolve the ref in the live page first", () => {
  // The refs as 0.8.0 wrote them to state.json, each with the selector it was
  // saved with. Refs have no selector now; an old file still loads, and its
  // "saved-" selectors must reach no op. The page answers with "fresh-" ones.
  const REFS = [
    { id: "e1", selector: "saved-a",      role: "link",     name: "Home",  tag: "a" },
    { id: "e2", selector: "saved-input",  role: "textbox",  name: "Email", tag: "input" },
    { id: "e3", selector: "saved-select", role: "combobox", name: "Color", tag: "select" },
    { id: "e4", selector: "saved-cb",     role: "checkbox", name: "Agree", tag: "input" },
  ];
  // Each ref command, the ref it acts on, and the action op that must carry the fresh selector.
  // The fifth column: whether the resolve script also refuses a disabled
  // element (F20). fill keeps its own disabled message; hover and select
  // do not refuse. The last: whether it refuses a covered one, for the
  // commands that click at the element's centre (#112).
  const COMMANDS: Array<[string, string, string, (x: CommandContext) => Promise<string>, boolean, boolean]> = [
    ["click",   "e1", "click",   (x) => cmdClick(x, "e1"), true, true],
    ["fill",    "e2", "click",   (x) => cmdFill(x, "e2", "hi"), false, true],
    ["hover",   "e1", "hover",   (x) => cmdHover(x, "e1"), false, false],
    ["select",  "e3", "select",  (x) => cmdSelect(x, "e3", "red"), false, false],
    ["check",   "e4", "check",   (x) => cmdCheck(x, "e4"), true, false],
    ["uncheck", "e4", "uncheck", (x) => cmdUncheck(x, "e4"), true, false],
  ];

  beforeEach(async () => {
    await ensureSessionDir(session);
    await Bun.write(join(sessionDir(session), "state.json"),
      JSON.stringify({ name: session, url: "https://x", title: "X", refs: REFS, doc: "doc-1", updatedAt: Date.now() }));
  });

  for (const [name, ref, op, run, enabled, hit] of COMMANDS) {
    const saved = REFS.find((r) => r.id === ref)!;
    const resolve = resolveRefScript(saved, { enabled, doc: "doc-1", ...(hit ? { hit } : {}) });
    if (hit) {
      for (const [by, said] of [
        [{ role: "generic", name: "", tag: "div" }, "generic <div>"],
        [{ role: "button", name: "+", tag: "button" }, 'button "+"'],
      ] as const) {
        test(`${name} on a ref covered by ${said} fails, exit 1, and sends no action (#112)`, async () => {
          const c = fakeClient({ resolve: (e) => (e === resolve ? { covered: by } : undefined) });
          const err = await run({ ...ctx(), connect: async () => c }).then(
            (out) => { throw new Error(`expected a failure, got ${out}`); },
            (e: Error) => e,
          );
          expect(err.message).toBe(
            `ref '${ref}' (${saved.role} "${saved.name}") is covered by ${said} at its click point; take a new snapshot or close what covers it`,
          );
          expect(reportFailure(err).code).toBe(1);
          expect(c.calls).toEqual([["resolve", [resolve]]]);
        });
      }
    }
    test(`${name} on a ref from another document fails, exit 1, and sends no action (#105)`, async () => {
      const c = fakeClient({ resolve: (e) => (e === resolve ? { gone: true } : undefined) });
      const err = await run({ ...ctx(), connect: async () => c }).then(
        (out) => { throw new Error(`expected a failure, got ${out}`); },
        (e: Error) => e,
      );
      expect(err.message).toBe(`ref '${ref}' is from a page that is no longer loaded; take a new snapshot`);
      expect(reportFailure(err).code).toBe(1);
      expect(c.calls).toEqual([["resolve", [resolve]]]);
    });

    test(`${name} on a ref whose element is gone fails with playwright-cli's message and sends no action`, async () => {
      const c = fakeClient({ evaluate: resolving({ [ref]: null }) });
      await expect(run({ ...ctx(), connect: async () => c })).rejects.toThrow(
        new Error(`ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`),
      );
      expect(c.calls).toEqual([["resolve", [resolve]]]);
    });

    test(`${name} on a ref whose element changed its role or name fails, exit 1, and sends no action`, async () => {
      const c = fakeClient({ evaluate: (e) => (e === resolve ? { changed: { role: "button", name: "Delete account" } } : undefined) });
      const err = await run({ ...ctx(), connect: async () => c }).then(
        (out) => { throw new Error(`expected a failure, got ${out}`); },
        (e: Error) => e,
      );
      expect(err.message).toBe(
        `ref '${ref}' now points to button "Delete account", not ${saved.role} "${saved.name}"; take a new snapshot`,
      );
      expect(reportFailure(err).code).toBe(1);
      expect(c.calls).toEqual([["resolve", [resolve]]]);
    });

    test(`${name} acts on the fresh selector the page returns, not the saved one`, async () => {
      const c = fakeClient({ evaluate: resolving({ [ref]: `fresh-${ref}` }) });
      await run({ ...ctx(), connect: async () => c });
      expect(c.calls[0]).toEqual(["resolve", [resolve]]);
      expect(c.calls.find(([o]) => o === op)?.[1][0]).toBe(`fresh-${ref}`);
      expect(JSON.stringify(c.calls)).not.toContain("saved-");
    });
  }

  test("fill clears the fresh selector", async () => {
    const c = fakeClient({ evaluate: resolving({ e2: "fresh-e2" }) });
    await cmdFill({ ...ctx(), connect: async () => c }, "e2", "hi");
    expect(c.calls).toContainEqual(["evaluate", [fillScript("fresh-e2", "hi")]]);
  });

  test("the resolve script embeds the ref, its role and its name with JSON.stringify", () => {
    const saved = { id: "e7", role: "button", name: 'Say "hi"' };
    for (const script of [resolveRefScript(saved), resolveRefScript(saved, { enabled: true })]) {
      expect(script).toContain(JSON.stringify("e7"));
      expect(script).toContain(JSON.stringify("button"));
      expect(script).toContain(JSON.stringify('Say "hi"'));
    }
  });

  test("the enabled check is a different script, so the fakes above tell them apart", () => {
    const saved = { id: "e7", role: "button", name: "Go" };
    expect(resolveRefScript(saved, { enabled: true })).not.toBe(resolveRefScript(saved));
  });
});

describe("screenshot", () => {
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  // #69: WebKit refuses to capture a viewport whose pixel buffer reaches
  // 4 GiB, and says only "An unknown error occurred". 16384x16384 at pixel
  // ratio 2 is 32768x32768 pixels; the tallest capture at that width is
  // 16383 (measured, Bun 1.4.2).
  const failingCapture = () => { throw new Error("An unknown error occurred"); };
  const viewport = (w: number, h: number, dpr: number) => (expr: string) =>
    expr === READ_VIEWPORT ? [w, h, dpr] : undefined;

  test("a viewport too large to capture is a UserError naming the size that fits (#69)", async () => {
    const c = fakeClient({ screenshot: failingCapture, evaluate: viewport(16384, 16384, 2) });
    const err = await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: join(tmp, "big.png") })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe(
      "screenshot: WebKit cannot capture a 16384x16384 viewport at pixel ratio 2 (its pixels would fill 4 GiB); " +
      "run 'bowser resize 16384 16383' or smaller",
    );
    expect(reportFailure(err).code).toBe(1);
  });

  test("a failed capture of a viewport that fits keeps its own error (#69)", async () => {
    const c = fakeClient({ screenshot: failingCapture, evaluate: viewport(800, 600, 2) });
    const err = await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: join(tmp, "small.png") })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UserError);
    expect((err as Error).message).toBe("An unknown error occurred");
  });

  test("a capture that works does not read the viewport (#69)", async () => {
    const c = fakeClient({ screenshot: () => PNG_B64 });
    await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: join(tmp, "ok.png") });
    expect(c.calls.map(([op]) => op)).not.toContain("evaluate");
  });

  test("--filename decodes the base64 and writes a real PNG at the given path", async () => {
    const tmpFile = join(tmp, `shot-${Date.now()}.png`);
    const c = fakeClient({ screenshot: () => PNG_B64 });
    const out = await cmdScreenshot({ ...ctx(), connect: async () => c }, { filename: tmpFile });
    expect(out).toBe(`wrote ${tmpFile}`);
    const written = new Uint8Array(await Bun.file(tmpFile).arrayBuffer());
    expect([...written.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("no --filename writes a default screenshot-<session>.png in the cwd", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const session = "shotdefault";
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      // The absolute path it wrote (F37): a relative one says nothing to a
      // caller that does not know this process's cwd.
      expect(out).toBe(`wrote ${join(realpathSync(tmp), "screenshot-shotdefault.png")}`);
      expect(await Bun.file(join(tmp, "screenshot-shotdefault.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("--json reports the absolute path, for a relative --filename too (F37)", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ ...ctx({ json: true }), connect: async () => c }, { filename: "rel-shot.png" });
      expect(JSON.parse(out)).toEqual({ ok: true, filename: join(realpathSync(tmp), "rel-shot.png") });
    } finally {
      process.chdir(origCwd);
    }
  });

  test("no --filename auto-increments when the default file already exists", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const session = "shotinc";
      await Bun.write(join(tmp, "screenshot-shotinc.png"), "existing");
      const c = fakeClient({ screenshot: () => PNG_B64 });
      const out = await cmdScreenshot({ session, json: false, connect: async () => c }, {});
      expect(out).toBe(`wrote ${join(realpathSync(tmp), "screenshot-shotinc-1.png")}`);
      expect(await Bun.file(join(tmp, "screenshot-shotinc-1.png")).exists()).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("sends an ABSOLUTE path so the daemon (different cwd) writes to the right place", async () => {
    const origCwd = process.cwd();
    process.chdir(tmp);
    try {
      const c = fakeClient({ screenshot: () => PNG_B64 });
      await cmdScreenshot(
        { session: "shotabs", json: false, connect: async () => c },
        { filename: "rel.png" },
      );
      const call = c.calls.find(([op]) => op === "screenshot")!;
      expect(isAbsolute(call[1][0] as string)).toBe(true);
      // Use process.cwd() after chdir — on macOS mkdtemp returns /var/... but
      // cwd() resolves symlinks to /private/var/..., so we must compare against
      // the resolved form rather than the raw tmp string.
      expect(call[1][0]).toBe(join(process.cwd(), "rel.png"));
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("resize", () => {
  test("sends the resize op with numeric width/height and reports them", async () => {
    const c = fakeClient({});
    const out = await cmdResize({ ...ctx(), connect: async () => c }, "800", "600");
    expect(out).toBe("resized 800x600");
    const call = c.calls.find(([op]) => op === "resize")!;
    expect(call[1]).toEqual([800, 600]);
  });

  test("--json reports ok with numeric dimensions", async () => {
    const c = fakeClient({});
    const out = await cmdResize({ ...ctx({ json: true }), connect: async () => c }, "1024", "768");
    expect(JSON.parse(out)).toEqual({ ok: true, width: 1024, height: 768 });
  });

  test.each([
    ["", "600"],
    ["800", ""],
    ["800", "0"],
    ["-1", "600"],
    ["800", "12.5"],
    ["wide", "600"],
    ["16385", "100"],
    ["100", "100000"],
  ])("rejects invalid dimensions (%p, %p) before any daemon request", async (w, h) => {
    const c = fakeClient({});
    await expect(
      cmdResize({ ...ctx(), connect: async () => c }, w, h),
    ).rejects.toThrow("usage: bowser resize <width> <height> (each 1 to 16384)");
    expect(c.calls).toEqual([]);
  });

  test("accepts WebKit's largest side, 16384 (F22)", async () => {
    const c = fakeClient({});
    expect(await cmdResize({ ...ctx(), connect: async () => c }, "16384", "16384")).toBe("resized 16384x16384");
  });
});

describe("localstorage", () => {
  test("list returns empty string when no entries", async () => {
    const c = fakeClient({ evaluate: () => ({}) });
    const out = await cmdLocalStorageList({ ...ctx(), connect: async () => c });
    expect(out).toBe("");
  });

  test("list renders k=v lines", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc", theme: "dark" }) });
    const out = await cmdLocalStorageList({ ...ctx(), connect: async () => c });
    expect(out.split("\n").sort()).toEqual(["theme=dark", "token=abc"]);
  });

  test("list --json returns object", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc" }) });
    const out = await cmdLocalStorageList({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ token: "abc" });
  });

  test("get returns raw value", async () => {
    const c = fakeClient({ evaluate: () => "abc" });
    const out = await cmdLocalStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("abc");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.getItem(\"token\")`);
  });

  test("get missing key returns empty string", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdLocalStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("");
  });

  test("get --json includes null for missing key", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdLocalStorageGet({ ...ctx({ json: true }), connect: async () => c }, "missing");
    expect(JSON.parse(out)).toEqual({ ok: true, key: "missing", value: null });
  });

  test("get rejects empty key", async () => {
    await expect(cmdLocalStorageGet(ctx(), "")).rejects.toThrow(/usage:/);
  });

  test("set sends setItem evaluate with JSON-escaped key/value", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageSet(
      { ...ctx(), connect: async () => c },
      "tok",
      `va"l`,
    );
    expect(out).toBe("set tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.setItem(\"tok\", \"va\\\"l\")`);
  });

  test("set rejects missing args", async () => {
    await expect(cmdLocalStorageSet(ctx(), "", "v")).rejects.toThrow(/usage:/);
  });

  test("delete sends removeItem evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageDelete({ ...ctx(), connect: async () => c }, "tok");
    expect(out).toBe("deleted tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.removeItem(\"tok\")`);
  });

  test("clear sends clear evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageClear({ ...ctx(), connect: async () => c });
    expect(out).toBe("cleared");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`localStorage.clear()`);
  });

  test("clear --json", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdLocalStorageClear({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ ok: true });
  });
});

describe("sessionstorage", () => {
  test("list returns empty string when no entries", async () => {
    const c = fakeClient({ evaluate: () => ({}) });
    const out = await cmdSessionStorageList({ ...ctx(), connect: async () => c });
    expect(out).toBe("");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain("sessionStorage.length");
  });

  test("list renders k=v lines", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc", theme: "dark" }) });
    const out = await cmdSessionStorageList({ ...ctx(), connect: async () => c });
    expect(out.split("\n").sort()).toEqual(["theme=dark", "token=abc"]);
  });

  test("list --json returns object", async () => {
    const c = fakeClient({ evaluate: () => ({ token: "abc" }) });
    const out = await cmdSessionStorageList({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ token: "abc" });
  });

  test("get returns raw value", async () => {
    const c = fakeClient({ evaluate: () => "abc" });
    const out = await cmdSessionStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("abc");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.getItem(\"token\")`);
  });

  test("get missing key returns empty string", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdSessionStorageGet({ ...ctx(), connect: async () => c }, "token");
    expect(out).toBe("");
  });

  test("get --json includes null for missing key", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdSessionStorageGet({ ...ctx({ json: true }), connect: async () => c }, "missing");
    expect(JSON.parse(out)).toEqual({ ok: true, key: "missing", value: null });
  });

  test("get rejects empty key", async () => {
    await expect(cmdSessionStorageGet(ctx(), "")).rejects.toThrow(/usage:/);
  });

  test("set sends setItem evaluate with JSON-escaped key/value", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageSet(
      { ...ctx(), connect: async () => c },
      "tok",
      `va"l`,
    );
    expect(out).toBe("set tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.setItem(\"tok\", \"va\\\"l\")`);
  });

  test("set rejects missing args", async () => {
    await expect(cmdSessionStorageSet(ctx(), "", "v")).rejects.toThrow(/usage:/);
  });

  test("delete sends removeItem evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageDelete({ ...ctx(), connect: async () => c }, "tok");
    expect(out).toBe("deleted tok");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.removeItem(\"tok\")`);
  });

  test("clear sends clear evaluate", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageClear({ ...ctx(), connect: async () => c });
    expect(out).toBe("cleared");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain(`sessionStorage.clear()`);
  });

  test("clear --json", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdSessionStorageClear({ ...ctx({ json: true }), connect: async () => c });
    expect(JSON.parse(out)).toEqual({ ok: true });
  });
});

describe("history (go-back/go-forward/reload)", () => {
  test("go-back", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "back");
    expect(c.calls).toContainEqual(["back", []]);
  });
  test("go-forward", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "forward");
    expect(c.calls).toContainEqual(["forward", []]);
  });
  test("reload", async () => {
    const c = fakeClient({});
    await cmdHistory({ ...ctx(), connect: async () => c }, "reload");
    expect(c.calls).toContainEqual(["reload", []]);
  });
});

describe("eval", () => {
  test("string result is printed as-is", async () => {
    const c = fakeClient({ evaluate: () => "hello" });
    const out = await cmdEval({ ...ctx(), connect: async () => c }, "document.title");
    expect(out).toBe("hello");
    expect(c.calls[0]).toEqual(["evaluate", ["document.title"]]);
  });

  test("object result is JSON.stringified", async () => {
    const c = fakeClient({ evaluate: () => ({ a: 1 }) });
    const out = await cmdEval({ ...ctx(), connect: async () => c }, "window.obj");
    expect(out).toBe('{"a":1}');
  });

  test("undefined result prints empty string", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdEval({ ...ctx(), connect: async () => c }, "void 0");
    expect(out).toBe("");
  });

  test("null result prints empty string", async () => {
    const c = fakeClient({ evaluate: () => null });
    const out = await cmdEval({ ...ctx(), connect: async () => c }, "null");
    expect(out).toBe("");
  });

  test("--json wraps result in { ok, result }", async () => {
    const c = fakeClient({ evaluate: () => 42 });
    const out = await cmdEval({ ...ctx({ json: true }), connect: async () => c }, "1+1");
    expect(JSON.parse(out)).toEqual({ ok: true, result: 42 });
  });

  test("empty expression throws usage error", async () => {
    await expect(cmdEval(ctx(), "")).rejects.toThrow(/^usage: bowser eval/);
  });

  test("missing expression throws usage error", async () => {
    await expect(cmdEval(ctx(), undefined as unknown as string)).rejects.toThrow(/^usage: bowser eval/);
  });
});

describe("run-code", () => {
  test("sends the code in runCodeScript and prints the page's value", async () => {
    const c = fakeClient({ evaluate: () => ({ value: 2 }) });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return 1+1");
    expect(out).toBe("2");
    expect(c.calls[0]![1][0]).toBe(runCodeScript("return 1+1"));
  });

  test("a function result exits 1 with the no-Playwright-page message (spec F18)", async () => {
    const c = fakeClient({ evaluate: () => ({ fn: true }) });
    const err = await cmdRunCode({ ...ctx(), connect: async () => c }, "async page => 1").then(() => null, (e: Error) => e);
    expect(err?.message).toBe("run-code runs JavaScript in the page and has no Playwright 'page'; write statements and use return");
    expect(reportFailure(err).code).toBe(1);
  });

  test("string result is printed as-is", async () => {
    const c = fakeClient({ evaluate: () => ({ value: "hi" }) });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return 'hi'");
    expect(out).toBe("hi");
  });

  test("object result is JSON.stringified", async () => {
    const c = fakeClient({ evaluate: () => ({ value: [1, 2, 3] }) });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return [1,2,3]");
    expect(out).toBe("[1,2,3]");
  });

  test("undefined result prints empty string", async () => {
    const c = fakeClient({ evaluate: () => ({}) });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "1+1");
    expect(out).toBe("");
  });

  test("--json wraps result in { ok, result }", async () => {
    const c = fakeClient({ evaluate: () => ({ value: "x" }) });
    const out = await cmdRunCode({ ...ctx({ json: true }), connect: async () => c }, "return 'x'");
    expect(JSON.parse(out)).toEqual({ ok: true, result: "x" });
  });

  test("empty code throws usage error", async () => {
    await expect(cmdRunCode(ctx(), "")).rejects.toThrow(/^usage: bowser run-code/);
  });

  test("missing code throws usage error", async () => {
    await expect(cmdRunCode(ctx(), undefined as unknown as string)).rejects.toThrow(/^usage: bowser run-code/);
  });
});

describe("context helpers", () => {
  test("reply picks JSON or text by ctx.json, with identical JSON.stringify output", () => {
    expect(reply({ session: "s", json: true }, { ok: true, ref: "e1" }, "clicked e1")).toBe(JSON.stringify({ ok: true, ref: "e1" }));
    expect(reply({ session: "s", json: false }, { ok: true, ref: "e1" }, "clicked e1")).toBe("clicked e1");
  });

  test("syncState keeps refs and name, replaces url and title, bumps updatedAt", async () => {
    const refs = [{ id: "e1", role: "link", name: "x", tag: "a" }];
    await saveState({ name: "sync", url: "https://old/", title: "Old", refs, updatedAt: 1 });
    const prev = (await loadState("sync"))!;
    await syncState(prev, { url: "https://new/", title: "New" });
    const next = (await loadState("sync"))!;
    expect(next.name).toBe("sync");
    expect(next.url).toBe("https://new/");
    expect(next.title).toBe("New");
    expect(next.refs).toEqual(prev.refs);
    expect(next.updatedAt).toBeGreaterThan(1);
  });
});

describe("fill --stdin", () => {
  const REFS = [{ id: "e2", role: "textbox", name: "Password", tag: "input" }];
  const SECRET = "hunter2-S3cr3t!";

  let connected: boolean;
  let c: ReturnType<typeof fakeClient>;
  let reads: number;
  /** A context whose stdin holds `input` and whose connect is recorded. */
  const sctx = (input: string, overrides: Partial<CommandContext> = {}): CommandContext => ({
    ...ctx(),
    connect: async () => { connected = true; return c; },
    readStdin: async () => { reads++; return input; },
    ...overrides,
  });
  const typed = () => c.calls.filter(([op]) => op === "type").map(([, a]) => a[0]);

  beforeEach(async () => {
    connected = false;
    reads = 0;
    c = fakeClient({ evaluate: resolving({ e2: "input" }) });
    await saveState({ name: session, url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() });
  });

  const CASES: Array<[string, string, string]> = [
    ["one trailing \\n is removed", `${SECRET}\n`, SECRET],
    ["one trailing \\r\\n is removed", `${SECRET}\r\n`, SECRET],
    ["input without a line ending is kept whole", SECRET, SECRET],
    ["only the last of two line endings is removed", `${SECRET}\n\n`, `${SECRET}\n`],
    ["only the last of two \\r\\n endings is removed", `${SECRET}\r\n\r\n`, `${SECRET}\r\n`],
    ["trailing spaces and tabs before the newline are kept", `${SECRET} \t\n`, `${SECRET} \t`],
    ["leading whitespace is kept", `  ${SECRET}\n`, `  ${SECRET}`],
    ["multi-line input keeps its inner newlines", "line one\nline two\n", "line one\nline two"],
    ["quotes are kept verbatim", `he said "hi" and 'bye'\n`, `he said "hi" and 'bye'`],
    ["dollar signs and backticks are kept verbatim", "$HOME $(id) `id` ${x}\n", "$HOME $(id) `id` ${x}"],
    ["backslashes are kept verbatim", "a\\b\\n\\\\\n", "a\\b\\n\\\\"],
    ["empty input fills the empty string", "", ""],
    ["a lone newline fills the empty string", "\n", ""],
  ];
  for (const [name, input, expected] of CASES) {
    test(`types stdin as given: ${name}`, async () => {
      await cmdFill(sctx(input), "e2", undefined, { stdin: true });
      expect(typed()).toEqual([expected]);
    });
  }

  test("the plain answer names the ref and does not echo the text", async () => {
    const out = await cmdFill(sctx(`${SECRET}\n`), "e2", undefined, { stdin: true });
    expect(out).toBe(`filled e2 (textbox "Password")`);
    expect(out).not.toContain(SECRET);
  });

  test("the --json answer has no text key and does not echo the text", async () => {
    const out = await cmdFill(sctx(`${SECRET}\n`, { json: true }), "e2", undefined, { stdin: true });
    expect(JSON.parse(out)).toEqual({ ok: true, ref: "e2", element: { role: "textbox", name: "Password" } });
    expect(out).not.toContain(SECRET);
  });

  test("fill <ref> <text> answers --json without the text", async () => {
    const out = await cmdFill(sctx("", { json: true }), "e2", SECRET);
    expect(JSON.parse(out)).toEqual({ ok: true, ref: "e2", element: { role: "textbox", name: "Password" } });
    expect(out).not.toContain(SECRET);
    expect(reads).toBe(0);
  });

  test("fill <ref> <text> answers in plain text without the text", async () => {
    const out = await cmdFill(sctx(""), "e2", SECRET);
    expect(out).toBe(`filled e2 (textbox "Password")`);
    expect(out).not.toContain(SECRET);
  });

  test("fill <ref> <text>: a missing, wrong-kind or stale ref error does not contain the text", async () => {
    await saveState({ name: session, url: "https://x", title: "X", refs: [
      ...REFS, { id: "e1", role: "listitem", name: "", tag: "li" },
    ], updatedAt: Date.now() });
    // e2 is stale: the page no longer has it, so liveSelector refuses.
    c = fakeClient({ evaluate: resolving({ e2: null }) });
    for (const ref of ["e1", "e9", "e2"]) {
      const err = await cmdFill(sctx(""), ref, SECRET).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(SECRET);
    }
    expect(typed()).toEqual([]);
  });

  test("--stdin with a <text> positional is a usage error before stdin or the daemon", async () => {
    await expect(cmdFill(sctx(SECRET), "e2", "x", { stdin: true })).rejects.toThrow(/^usage: .*--stdin/);
    expect(reads).toBe(0);
    expect(connected).toBe(false);
  });

  test("neither <text> nor --stdin is a usage error naming both forms", async () => {
    await expect(cmdFill(sctx(SECRET), "e2", undefined)).rejects.toThrow(/^usage: bowser fill <ref> <text>.*--stdin/);
    expect(reads).toBe(0);
    expect(connected).toBe(false);
  });

  test("stdin is read before any daemon request", async () => {
    const order: string[] = [];
    await cmdFill(
      sctx("", {
        readStdin: async () => { order.push("stdin"); return SECRET; },
        connect: async () => { order.push("connect"); return c; },
      }),
      "e2", undefined, { stdin: true },
    );
    expect(order).toEqual(["stdin", "connect"]);
  });

  test("an error after reading stdin does not contain the text", async () => {
    // Wrong-kind and missing refs are the errors that follow the read.
    await saveState({ name: session, url: "https://x", title: "X", refs: [
      { id: "e1", role: "listitem", name: "", tag: "li" },
    ], updatedAt: Date.now() });
    for (const ref of ["e1", "e9"]) {
      const err = await cmdFill(sctx(SECRET), ref, undefined, { stdin: true }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(SECRET);
    }
    expect(connected).toBe(false);
  });

  test("the registry's fill reads stdin under --stdin", async () => {
    await findCommand("fill")!.run(sctx(`${SECRET}\n`), { positional: ["e2"], flags: { stdin: true } });
    expect(typed()).toEqual([SECRET]);
  });

  test("the registry's fill refuses --stdin with a <text> positional", async () => {
    await expect(
      findCommand("fill")!.run(sctx(SECRET), { positional: ["e2", "x"], flags: { stdin: true } }),
    ).rejects.toThrow(/^usage:/);
    expect(connected).toBe(false);
  });

  test("the registry's fill without <text> or --stdin is a usage error, not an empty fill", async () => {
    await expect(findCommand("fill")!.run(sctx(SECRET), { positional: ["e2"], flags: {} })).rejects.toThrow(/^usage:/);
    expect(connected).toBe(false);
  });

  test("the registry's fill <ref> \"\" still fills the empty string", async () => {
    await findCommand("fill")!.run(sctx(SECRET), { positional: ["e2", ""], flags: {} });
    expect(typed()).toEqual([""]);
    expect(reads).toBe(0);
  });

  test("the default reader refuses a terminal with a usage error and does not read", async () => {
    let read = false;
    await expect(readStdin({ isTTY: true }, async () => { read = true; return SECRET; })).rejects.toThrow(/^usage: .*--stdin/);
    expect(read).toBe(false);
  });

  test("the default reader reads a pipe", async () => {
    expect(await readStdin({ isTTY: false }, async () => SECRET)).toBe(SECRET);
    expect(await readStdin({}, async () => SECRET)).toBe(SECRET);
  });

  test("the CLI exits 1 on --stdin plus <text>, without a daemon or echoing stdin", async () => {
    const home = await mkdtemp(join(tmpdir(), "bowser-stdin-"));
    const prevHome = process.env.HOME;
    const inHome = async <T>(fn: () => Promise<T>): Promise<T> => {
      process.env.HOME = home;
      try { return await fn(); } finally { process.env.HOME = prevHome; }
    };
    try {
      await inHome(() => saveState({ name: "stdin", url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() }));
      const p = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "-s", "stdin", "fill", "e2", "x", "--stdin"],
        env: { ...process.env, HOME: home },
        stdin: new TextEncoder().encode(`${SECRET}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(stderr).toStartWith("bowser: usage:");
      expect(stdout + stderr).not.toContain(SECRET);
      expect(code).toBe(1);
      expect(existsSync(await inHome(async () => pidPath("stdin")))).toBe(false);
    } finally {
      const pid = Number(await inHome(() => Bun.file(pidPath("stdin")).text()).catch(() => ""));
      if (pid > 0) try { process.kill(pid); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  });
});
describe("dialogs", () => {
  const dismissed = { type: "confirm" as const, message: "sure?", state: "dismissed" as const, unanswered: true as const };
  const DISMISSED_OUT = '### Modal state\n- ["confirm" dialog with message "sure?"]: dismissed (run dialog-accept before the action to accept it)';

  async function clickable() {
    await saveState({
      name: session, url: "https://x", title: "X", updatedAt: Date.now(),
      refs: [
        { id: "e1", role: "button", name: "go", tag: "button" },
        { id: "e2", role: "textbox", name: "Email", tag: "input" },
      ],
    });
  }

  test("a click during which a dialog was answered prints its answer and then the modal state", async () => {
    await clickable();
    const c = fakeClient({ evaluate: resolving({ e1: "button" }) }, { dialogs: [dismissed] });
    const out = await cmdClick({ ...ctx(), connect: async () => c }, "e1");
    expect(out).toBe(`clicked e1 (button "go")\n${DISMISSED_OUT}`);
  });

  test("--json: the command's object gains a dialogs array, without the internal hint flag", async () => {
    await clickable();
    const c = fakeClient({ evaluate: resolving({ e1: "button" }) }, { dialogs: [dismissed] });
    const out = JSON.parse(await cmdClick({ ...ctx({ json: true }), connect: async () => c }, "e1"));
    expect(out.dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed" }]);
  });

  test("no dialog, no modal state and no dialogs key", async () => {
    await clickable();
    const c = fakeClient({ evaluate: resolving({ e1: "button" }) });
    expect(await cmdClick({ ...ctx(), connect: async () => c }, "e1")).toBe('clicked e1 (button "go")');
    const json = JSON.parse(await cmdClick({ ...ctx({ json: true }), connect: async () => c }, "e1"));
    expect("dialogs" in json).toBe(false);
  });

  test("answered dialogs print their answer; only a dismissal for lack of an answer carries the hint, and never an alert's", async () => {
    const c = fakeClient({ evaluate: () => "done" }, {
      dialogs: [
        { type: "confirm", message: "sure?", state: "accepted" },
        { type: "prompt", message: "name?", defaultValue: "def", state: "dismissed", unanswered: true },
        { type: "alert", message: "hi", state: "dismissed", unanswered: true },
      ],
    });
    const out = await cmdEval({ ...ctx(), connect: async () => c }, "go()");
    expect(out).toBe([
      "done",
      "### Modal state",
      '- ["confirm" dialog with message "sure?"]: accepted',
      '- ["prompt" dialog with message "name?"]: dismissed (run dialog-accept before the action to accept it)',
      '- ["alert" dialog with message "hi"]: dismissed',
    ].join("\n"));
  });

  test("--json dialogs carry type, message, defaultValue, state and answer, and nothing else", async () => {
    const c = fakeClient({ evaluate: () => 1 }, {
      dialogs: [
        { type: "prompt", message: "name?", defaultValue: "def", state: "accepted", answer: "typed" },
        { type: "prompt", message: "again?", defaultValue: "", state: "dismissed", unanswered: true },
      ],
    });
    const out = JSON.parse(await cmdEval({ ...ctx({ json: true }), connect: async () => c }, "go()"));
    expect(out).toEqual({
      ok: true, result: 1,
      dialogs: [
        { type: "prompt", message: "name?", defaultValue: "def", state: "accepted", answer: "typed" },
        { type: "prompt", message: "again?", defaultValue: "", state: "dismissed" },
      ],
    });
  });

  test("goto, fill, press, hover, select, check, uncheck, type, run-code, go-back and open report dialogs too", async () => {
    await saveState({
      name: session, url: "https://x", title: "X", updatedAt: Date.now(),
      refs: [
        { id: "e2", role: "textbox", name: "Email", tag: "input" },
        { id: "e3", role: "combobox", name: "Color", tag: "select" },
        { id: "e4", role: "checkbox", name: "Agree", tag: "input" },
      ],
    });
    const c = () => fakeClient({ evaluate: resolving({ e2: "input", e3: "select", e4: "input.cb" }) }, { dialogs: [dismissed] });
    const outs = [
      await cmdGoto({ ...ctx(), connect: async () => c() }, "https://x/"),
      await cmdFill({ ...ctx(), connect: async () => c() }, "e2", "x"),
      await cmdPress({ ...ctx(), connect: async () => c() }, "Enter"),
      await cmdHover({ ...ctx(), connect: async () => c() }, "e4"),
      await cmdSelect({ ...ctx(), connect: async () => c() }, "e3", "blue"),
      await cmdCheck({ ...ctx(), connect: async () => c() }, "e4"),
      await cmdUncheck({ ...ctx(), connect: async () => c() }, "e4"),
      await cmdType({ ...ctx(), connect: async () => c() }, "hi"),
      await cmdRunCode({ ...ctx(), connect: async () => c() }, "return 1"),
      await cmdHistory({ ...ctx(), connect: async () => c() }, "back"),
      // Last: open starts a fresh page, so it clears the saved refs.
      await cmdOpen({ ...ctx(), connect: async () => c() }, "https://x/"),
    ];
    for (const out of outs) expect(out.endsWith(DISMISSED_OUT)).toBe(true);
  });

  test("dialog-accept [text] and dialog-dismiss set the answer for the next dialog and say so", async () => {
    const c = fakeClient();
    expect(await cmdDialog({ ...ctx(), connect: async () => c }, true, "typed")).toBe("next dialog will be accepted");
    expect(await cmdDialog({ ...ctx(), connect: async () => c }, false)).toBe("next dialog will be dismissed");
    expect(c.calls).toEqual([["dialog-answer", [true, "typed"]], ["dialog-answer", [false]]]);
    expect(JSON.parse(await cmdDialog({ ...ctx({ json: true }), connect: async () => c }, true)))
      .toEqual({ ok: true, next: "accepted" });
  });

  test("dialog-accept [text] and dialog-dismiss are registered commands", async () => {
    const c = fakeClient();
    await findCommand("dialog-accept")!.run({ ...ctx(), connect: async () => c }, { positional: ["typed"], flags: {} });
    await findCommand("dialog-dismiss")!.run({ ...ctx(), connect: async () => c }, { positional: [], flags: {} });
    expect(c.calls).toEqual([["dialog-answer", [true, "typed"]], ["dialog-answer", [false]]]);
  });

  test("snapshot prints the queued dialogs after the page lines and still renders the tree", async () => {
    const snap = { url: "https://x/", title: "X", tree: [{ role: "button", name: "go", ref: "e1", children: [] }], refs: [] };
    const c = fakeClient({ evaluate: () => snap }, { dialogs: [dismissed] });
    const out = await cmdSnapshot({ ...ctx(), connect: async () => c }, {});
    expect(out.startsWith(`### Page\n- Page URL: https://x/\n- Page Title: X\n${DISMISSED_OUT}\n### Snapshot\n`)).toBe(true);
    expect(out).toContain('button "go" [ref=e1]');
    const json = JSON.parse(await cmdSnapshot({ ...ctx({ json: true }), connect: async () => fakeClient({ evaluate: () => snap }, { dialogs: [dismissed] }) }, {}));
    expect(json.dialogs).toEqual([{ type: "confirm", message: "sure?", state: "dismissed" }]);
    expect(typeof json.snapshot).toBe("string");
  });

  test("snapshot with no dialogs has no modal state and no dialogs key", async () => {
    const snap = { url: "https://x/", title: "X", tree: [], refs: [] };
    expect(await cmdSnapshot({ ...ctx(), connect: async () => fakeClient({ evaluate: () => snap }) }, {})).not.toContain("Modal state");
    const json = JSON.parse(await cmdSnapshot({ ...ctx({ json: true }), connect: async () => fakeClient({ evaluate: () => snap }) }, {}));
    expect("dialogs" in json).toBe(false);
  });

  test("commands that print no dialogs do not take the daemon's queued reports", async () => {
    const shot = fakeClient({}, { dialogs: [dismissed] });
    await cmdScreenshot({ ...ctx(), connect: async () => shot }, { filename: join(tmpdir(), `bowser-shot-${Date.now()}.png`) });
    expect(shot.reporting).toBe(false);
    const storage = fakeClient({ evaluate: () => ({}) }, { dialogs: [dismissed] });
    await cmdLocalStorageList({ ...ctx(), connect: async () => storage });
    expect(storage.reporting).toBe(false);
  });
});

describe("a failed page command still reports its dialogs", () => {
  const dismissed = { type: "confirm" as const, message: "sure?", state: "dismissed" as const, unanswered: true as const };
  const MODAL = '### Modal state\n- ["confirm" dialog with message "sure?"]: dismissed (run dialog-accept before the action to accept it)';

  test("eval that throws after a confirm: the error unchanged, then the report, exit code 2", async () => {
    const c = fakeClient({ evaluate: () => { throw new Error("Error: boom"); } }, { dialogs: [dismissed] });
    const err = await run([`--session=${session}`, "eval", "confirm('sure?'); throw new Error('boom')"], { connect: async () => c }).catch((e) => e);
    expect(reportFailure(err)).toEqual({ stderr: `bowser: Error: boom\n${MODAL}`, code: 2 });
  });

  test("a user error keeps exit code 1 and its message first", async () => {
    await saveState({
      name: session, url: "https://x", title: "X", updatedAt: Date.now(),
      refs: [{ id: "e1", role: "button", name: "go", tag: "button" }],
    });
    const c = fakeClient({ evaluate: () => null }, { dialogs: [dismissed] });
    const err = await run([`--session=${session}`, "click", "e1"], { connect: async () => c }).catch((e) => e);
    const { stderr, code } = reportFailure(err);
    expect(stderr).toStartWith("bowser: ref 'e1' not found in the current page snapshot.");
    expect(stderr).toEndWith(`\n${MODAL}`);
    expect(code).toBe(1);
  });

  test("a failure with no dialogs prints only the error", async () => {
    const c = fakeClient({ evaluate: () => { throw new Error("Error: boom"); } });
    const err = await run([`--session=${session}`, "eval", "x"], { connect: async () => c }).catch((e) => e);
    expect(reportFailure(err)).toEqual({ stderr: "bowser: Error: boom", code: 2 });
  });
});

describe("fill and type errors never carry the entered text", () => {
  const SECRET = "hunter2-S3cr3t!";
  const dismissed = { type: "confirm" as const, message: "sure?", state: "dismissed" as const, unanswered: true as const };
  const MODAL = '### Modal state\n- ["confirm" dialog with message "sure?"]: dismissed (run dialog-accept before the action to accept it)';
  const withheld = (cmd: string) => `${cmd}: the browser's error message was withheld because it contained the entered text`;
  /** A client whose `type` request fails with `message`. */
  const failing = (message: string, opts: Parameters<typeof fakeClient>[1] = {}) =>
    fakeClient({ evaluate: resolving({ e2: "input" }), type: () => { throw new Error(message); } }, opts);

  beforeEach(async () => {
    await saveState({ name: session, url: "https://x", title: "X", updatedAt: Date.now(),
      refs: [{ id: "e2", role: "textbox", name: "Password", tag: "input" }] });
  });

  const RUNS: Array<[string, string, (c: ReturnType<typeof fakeClient>) => Promise<string>]> = [
    ["fill <ref> <text>", "fill", (c) => cmdFill({ ...ctx(), connect: async () => c }, "e2", SECRET)],
    ["fill --stdin", "fill", (c) => cmdFill({ ...ctx(), connect: async () => c, readStdin: async () => `${SECRET}\n` }, "e2", undefined, { stdin: true })],
    ["type", "type", (c) => cmdType({ ...ctx(), connect: async () => c }, SECRET)],
  ];
  for (const [name, cmd, go] of RUNS) {
    test(`${name}: a browser error containing the text is withheld from stderr`, async () => {
      const err = await go(failing(`failed: ${SECRET}`)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(reportFailure(err)).toEqual({ stderr: `bowser: ${withheld(cmd)}`, code: 2 });
    });

    test(`${name}: the withheld error keeps the dialogs the command answered`, async () => {
      const err = await go(failing(`failed: ${SECRET}`, { dialogs: [dismissed] })).catch((e: unknown) => e);
      expect(reportFailure(err)).toEqual({ stderr: `bowser: ${withheld(cmd)}\n${MODAL}`, code: 2 });
    });

    test(`${name}: an error without the text passes through unchanged`, async () => {
      const err = await go(failing("failed: boom")).catch((e: unknown) => e);
      expect(reportFailure(err)).toEqual({ stderr: "bowser: failed: boom", code: 2 });
    });
  }
});
