// Command-layer tests with a fake daemon client. No real Chromium needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { findCommand } from "../src/cli/registry.ts";
import { cmdDialog } from "../src/commands/dialog.ts";
import { readStdin, reply, syncState, type CommandContext } from "../src/commands/context.ts";
import { pidPath } from "../src/daemon/client.ts";
import { cmdInstall } from "../src/commands/install.ts";
import {
  cmdCheck, cmdClick, cmdFill, cmdHover, cmdPress, cmdResize, cmdSelect, cmdType, cmdUncheck,
} from "../src/commands/interaction.ts";
import {
  closeOne, cmdClose, cmdGoto, cmdHistory, cmdList, cmdOpen, looksLikeOurDaemon,
  type ProcessOps,
} from "../src/commands/navigation.ts";
import { cmdCookieList } from "../src/commands/cookies.ts";
import { cmdEval, cmdRunCode } from "../src/commands/scripting.ts";
import { cmdScreenshot, cmdSnapshot } from "../src/commands/snapshot.ts";
import {
  cmdLocalStorageClear, cmdLocalStorageDelete, cmdLocalStorageGet, cmdLocalStorageList,
  cmdLocalStorageSet, cmdSessionStorageClear, cmdSessionStorageDelete, cmdSessionStorageGet,
  cmdSessionStorageList, cmdSessionStorageSet,
} from "../src/commands/web-storage.ts";
import { ensureSessionDir, saveState, loadState, sessionDir } from "../src/state.ts";
import { fakeClient } from "./helpers/fake-client.ts";
import { clearForFillScript, resolveRefScript } from "../src/page-scripts.ts";

/** An evaluate handler that answers the ref-resolve script the way the page
 *  would: the element's fresh selector, or null when it is gone. Any other
 *  script evaluates to undefined, the fake's default. */
function resolving(live: Record<string, string | null>) {
  return (expr: string): unknown => {
    for (const [id, selector] of Object.entries(live)) if (expr === resolveRefScript(id)) return selector;
    return undefined;
  };
}

async function seedRefs() {
  await saveState({
    name: "default",
    url: "https://x",
    title: "X",
    refs: [
      { id: "e1", selector: "a",        role: "link",     name: "Home",  tag: "a" },
      { id: "e2", selector: "input",    role: "textbox",  name: "Email", tag: "input" },
      { id: "e3", selector: "select",   role: "combobox", name: "Color", tag: "select" },
      { id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" },
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

  test("no flag hands the daemon no profile and asks it nothing extra", async () => {
    const { seen, calls } = await openWith({});
    expect(seen[0]?.profile).toBeUndefined();
    expect(calls().map(([op]) => op)).toEqual(["navigate", "state"]);
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
      socket: {
        data(s, data) {
          for (const line of data.toString().split("\n").filter(Boolean)) {
            const req = JSON.parse(line) as { id: number; op: string };
            const result = req.op === "state" ? { url: "about:blank", title: "" } : "pong";
            s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
          }
        },
      },
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
      // No inherited backend settings: an invalid BOWSER_BACKEND is refused
      // before mkdir, and would fail this test for the wrong reason.
      { env: { ...process.env, HOME: tmp, BOWSER_BACKEND: undefined, BOWSER_CHROMIUM_PATH: undefined }, stdout: "pipe", stderr: "pipe" },
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
    refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
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
  test("--json prints { snapshot: <tree> } only", async () => {
    const c = fakeClient({ evaluate: () => snap });
    const out = await cmdSnapshot({ ...ctx({ json: true }), connect: async () => c }, {});
    expect(JSON.parse(out)).toEqual({ snapshot: '- link "Home" [ref=e1]:\n  - /url: /' });
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

  test("--all keeps a legacy directory whose recorded pid is alive", async () => {
    // Its daemon can no longer be identified by name, so it is never signalled
    // and its directory stays for a person to deal with.
    const legacy = join(tmp, ".bowser", "sessions", "team one");
    await mkdir(legacy, { recursive: true });
    await Bun.write(join(legacy, "pid"), String(process.pid));
    try {
      const out = await cmdClose({ ...ctx(), connect: unreachable }, { all: true });
      expect(out).toContain("failed: team one");
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
      const out = await cmdClose({ ...ctx(), connect: unreachable }, { all: true });
      expect(out).toContain("failed: old session");
      expect(existsSync(legacy)).toBe(true);
    } finally {
      await rm(legacy, { recursive: true, force: true });
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

  test("omits a session whose daemon connects but never answers", async () => {
    await ensureSessionDir("wedged");
    const hung = fakeClient({ ping: () => new Promise<"pong">(() => {}) });
    const out = await cmdList({ ...ctx(), connect: async () => hung });
    expect(out.split("\n")).not.toContain("wedged");
  }, 10_000);

  test("--json carries the same filtered set", async () => {
    await seedSessions();
    const out = await cmdList({ ...ctx(), json: true, connect: only(["live-a"]) });
    expect(JSON.parse(out)).toEqual(["live-a"]);
  });
});

describe("install", () => {
  test("skips when chromium already detected", async () => {
    let spawned = false;
    const out = await cmdInstall(ctx(), {
      force: false,
      detect: () => "/fake/chromium",
      spawn: async () => { spawned = true; return 0; },
    });
    expect(out).toContain("already available");
    expect(spawned).toBe(false);
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
          { id: "e1", selector: "html > body > button", role: "button", name: "Go", tag: "button" },
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
          { id: "e1", selector: "html > body > input", role: "textbox", name: "Email", tag: "input" },
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
      refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e1: "a" }) });
    const out = await cmdClick({ ...ctx(), connect: async () => c }, "e1");
    expect(out).toContain("clicked e1");
    expect(c.calls).toContainEqual(["click", ["a"]]);
  });
});

describe("fill", () => {
  test("clicks, clears, types", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e2", selector: "input", role: "textbox", name: "Email", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e2: "input" }) });
    await cmdFill({ ...ctx(), connect: async () => c }, "e2", "hi");
    const ops = c.calls.map((cl) => cl[0]);
    expect(ops).toEqual(["evaluate", "click", "evaluate", "type"]);
  });
});

describe("type", () => {
  test("types into focused element", async () => {
    const c = fakeClient({});
    await cmdType({ ...ctx(), connect: async () => c }, "abc");
    expect(c.calls).toContainEqual(["type", ["abc"]]);
  });
});

describe("press", () => {
  test("presses a key", async () => {
    const c = fakeClient({});
    await cmdPress({ ...ctx(), connect: async () => c }, "Enter");
    expect(c.calls).toContainEqual(["press", ["Enter"]]);
  });
});

describe("hover", () => {
  test("hovers a ref", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
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
      refs: [{ id: "e3", selector: "select", role: "combobox", name: "Color", tag: "select" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e3: "select" }) });
    await cmdSelect({ ...ctx(), connect: async () => c }, "e3", "red");
    expect(c.calls).toContainEqual(["select", ["select", "red"]]);
  });
});

describe("check / uncheck", () => {
  test("check sends check op", async () => {
    await saveState({
      name: session,
      url: "https://x",
      title: "X",
      refs: [{ id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" }],
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
      refs: [{ id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" }],
      updatedAt: Date.now(),
    });
    const c = fakeClient({ evaluate: resolving({ e4: "input.cb" }) });
    await cmdUncheck({ ...ctx(), connect: async () => c }, "e4");
    expect(c.calls).toContainEqual(["uncheck", ["input.cb"]]);
  });
});

describe("actions refuse a ref of the wrong kind", () => {
  // One ref per kind the spec (§5) names, plus non-interactive ones that full-tree
  // snapshots now give refs to.
  const REFS = [
    { id: "e1",  selector: "li",       role: "listitem",         name: "",       tag: "li" },
    { id: "e2",  selector: "input.cb", role: "checkbox",         name: "Agree",  tag: "input" },
    { id: "e3",  selector: "input.r",  role: "radio",            name: "Red",    tag: "input" },
    { id: "e4",  selector: "button.s", role: "switch",           name: "Dark",   tag: "button" },
    { id: "e5",  selector: "div.mc",   role: "menuitemcheckbox", name: "Bold",   tag: "div" },
    { id: "e6",  selector: "div.mr",   role: "menuitemradio",    name: "Left",   tag: "div" },
    { id: "e7",  selector: "select",   role: "combobox",         name: "Color",  tag: "select" },
    { id: "e8",  selector: "input.t",  role: "textbox",          name: "Email",  tag: "input" },
    { id: "e9",  selector: "textarea", role: "textbox",          name: "Notes",  tag: "textarea" },
    { id: "e10", selector: "input.q",  role: "searchbox",        name: "Search", tag: "input" },
    { id: "e11", selector: "input.n",  role: "spinbutton",       name: "Qty",    tag: "input" },
    { id: "e12", selector: "input.l",  role: "combobox",         name: "City",   tag: "input" },
    { id: "e13", selector: "div.ce",   role: "generic",          name: "",       tag: "div", editable: true },
    { id: "e14", selector: "p",        role: "paragraph",        name: "",       tag: "p" },
  ];

  let connected: boolean;
  let c: ReturnType<typeof fakeClient>;
  const actx = () => ({ ...ctx(), connect: async () => { connected = true; return c; } });

  beforeEach(async () => {
    connected = false;
    c = fakeClient({ evaluate: resolving(Object.fromEntries(REFS.map((r) => [r.id, r.selector]))) });
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
      const sel = REFS.find((r) => r.id === id)!.selector;
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
  // Saved selectors start with "saved-"; the page answers with "fresh-" ones.
  const REFS = [
    { id: "e1", selector: "saved-a",      role: "link",     name: "Home",  tag: "a" },
    { id: "e2", selector: "saved-input",  role: "textbox",  name: "Email", tag: "input" },
    { id: "e3", selector: "saved-select", role: "combobox", name: "Color", tag: "select" },
    { id: "e4", selector: "saved-cb",     role: "checkbox", name: "Agree", tag: "input" },
  ];
  // Each ref command, the ref it acts on, and the action op that must carry the fresh selector.
  const COMMANDS: Array<[string, string, string, (x: CommandContext) => Promise<string>]> = [
    ["click",   "e1", "click",   (x) => cmdClick(x, "e1")],
    ["fill",    "e2", "click",   (x) => cmdFill(x, "e2", "hi")],
    ["hover",   "e1", "hover",   (x) => cmdHover(x, "e1")],
    ["select",  "e3", "select",  (x) => cmdSelect(x, "e3", "red")],
    ["check",   "e4", "check",   (x) => cmdCheck(x, "e4")],
    ["uncheck", "e4", "uncheck", (x) => cmdUncheck(x, "e4")],
  ];

  beforeEach(async () => {
    await saveState({ name: session, url: "https://x", title: "X", refs: REFS, updatedAt: Date.now() });
  });

  for (const [name, ref, op, run] of COMMANDS) {
    test(`${name} on a ref whose element is gone fails with playwright-cli's message and sends no action`, async () => {
      const c = fakeClient({ evaluate: resolving({ [ref]: null }) });
      await expect(run({ ...ctx(), connect: async () => c })).rejects.toThrow(
        new Error(`ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`),
      );
      expect(c.calls).toEqual([["evaluate", [resolveRefScript(ref)]]]);
    });

    test(`${name} acts on the fresh selector the page returns, not the saved one`, async () => {
      const c = fakeClient({ evaluate: resolving({ [ref]: `fresh-${ref}` }) });
      await run({ ...ctx(), connect: async () => c });
      expect(c.calls[0]).toEqual(["evaluate", [resolveRefScript(ref)]]);
      expect(c.calls.find(([o]) => o === op)?.[1][0]).toBe(`fresh-${ref}`);
      expect(JSON.stringify(c.calls)).not.toContain("saved-");
    });
  }

  test("fill clears the fresh selector", async () => {
    const c = fakeClient({ evaluate: resolving({ e2: "fresh-e2" }) });
    await cmdFill({ ...ctx(), connect: async () => c }, "e2", "hi");
    expect(c.calls).toContainEqual(["evaluate", [clearForFillScript("fresh-e2")]]);
  });

  test("the resolve script embeds the ref with JSON.stringify", () => {
    expect(resolveRefScript("e7")).toContain(JSON.stringify("e7"));
  });
});

describe("screenshot", () => {
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
      expect(out).toBe("wrote screenshot-shotdefault.png");
      expect(await Bun.file(join(tmp, "screenshot-shotdefault.png")).exists()).toBe(true);
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
      expect(out).toBe("wrote screenshot-shotinc-1.png");
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
  ])("rejects invalid dimensions (%p, %p)", async (w, h) => {
    const c = fakeClient({});
    await expect(
      cmdResize({ ...ctx(), connect: async () => c }, w, h),
    ).rejects.toThrow(/usage: bowser resize/);
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
  test("wraps code in IIFE before sending to evaluate", async () => {
    const c = fakeClient({ evaluate: () => 2 });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return 1+1");
    expect(out).toBe("2");
    const expr = c.calls[0]![1][0] as string;
    expect(expr).toContain("return 1+1");
    expect(expr).toContain("() => {");
    expect(expr).toContain("})()");
  });

  test("string result is printed as-is", async () => {
    const c = fakeClient({ evaluate: () => "hi" });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return 'hi'");
    expect(out).toBe("hi");
  });

  test("object result is JSON.stringified", async () => {
    const c = fakeClient({ evaluate: () => [1, 2, 3] });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "return [1,2,3]");
    expect(out).toBe("[1,2,3]");
  });

  test("undefined result prints empty string", async () => {
    const c = fakeClient({ evaluate: () => undefined });
    const out = await cmdRunCode({ ...ctx(), connect: async () => c }, "1+1");
    expect(out).toBe("");
  });

  test("--json wraps result in { ok, result }", async () => {
    const c = fakeClient({ evaluate: () => "x" });
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
    const refs = [{ id: "e1", selector: "a", role: "link", name: "x", tag: "a" }];
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
  const REFS = [{ id: "e2", selector: "input", role: "textbox", name: "Password", tag: "input" }];
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
    expect(JSON.parse(out)).toEqual({ ok: true, ref: "e2" });
    expect(out).not.toContain(SECRET);
  });

  test("fill <ref> <text> still echoes the text under --json", async () => {
    const out = await cmdFill(sctx("", { json: true }), "e2", "visible");
    expect(JSON.parse(out)).toEqual({ ok: true, ref: "e2", text: "visible" });
    expect(reads).toBe(0);
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
      { id: "e1", selector: "li", role: "listitem", name: "", tag: "li" },
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
        // No inherited backend settings: an invalid BOWSER_BACKEND would fail
        // this for the wrong reason.
        env: { ...process.env, HOME: home, BOWSER_BACKEND: undefined, BOWSER_CHROMIUM_PATH: undefined },
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
        { id: "e1", selector: "button", role: "button", name: "go", tag: "button" },
        { id: "e2", selector: "input", role: "textbox", name: "Email", tag: "input" },
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
        { id: "e2", selector: "input", role: "textbox", name: "Email", tag: "input" },
        { id: "e3", selector: "select", role: "combobox", name: "Color", tag: "select" },
        { id: "e4", selector: "input.cb", role: "checkbox", name: "Agree", tag: "input" },
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
    const cookies = fakeClient({}, { dialogs: [dismissed] });
    await cmdCookieList({ ...ctx(), connect: async () => cookies });
    expect(cookies.reporting).toBe(false);
  });
});
