// Exit codes through run() and reportFailure, with a fake daemon (#51 item 3).
// A user error is exit 1 because its throw site says so (`UserError`), never
// because of what its message says: an error from the page is exit 2 even
// when its text reads like one of bowser's own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure, run } from "../src/cli.ts";
import { findCommand } from "../src/cli/registry.ts";
import { readStdin, type CommandContext } from "../src/commands/context.ts";
import { connectOrSpawn, pidPath } from "../src/daemon/client.ts";
import { toArgv } from "../src/mcp.ts";
import { resolveRefScript } from "../src/page-scripts.ts";
import { saveState } from "../src/state.ts";
import { fakeClient, type FakeHandlers } from "./helpers/fake-client.ts";

let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-exit-codes-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

/** How `run(argv)` fails against a fake daemon: the CLI's stderr and exit code. */
async function failure(argv: string[], handlers: FakeHandlers = {}, base: Partial<CommandContext> = {}) {
  try {
    const out = await run(argv, { connect: async () => fakeClient(handlers), ...base });
    return { stderr: `no failure: ${out}`, code: 0 };
  } catch (err) {
    return reportFailure(err);
  }
}

describe("an error from the page is a runtime error (exit 2), whatever its text", () => {
  // Measured before the fix: both exited 1, because a regex over the message
  // took the page's text for a user error.
  for (const text of ["usage: from the page", "ref 'e1' not found anywhere", "no open page here", "bowser requires a break"]) {
    test(`eval failing with ${JSON.stringify(text)}`, async () => {
      const r = await failure(["eval", "boom()"], { evaluate: () => { throw new Error(text); } });
      expect(r).toEqual({ stderr: `bowser: ${text}`, code: 2 });
    });
  }
});

/** A saved snapshot with one ref of each kind the commands check. */
async function seed(session: string): Promise<void> {
  await saveState({
    name: session, url: "https://x/", title: "X", updatedAt: Date.now(),
    refs: [
      { id: "e1", role: "button", name: "Go", tag: "button" },
      { id: "e2", role: "textbox", name: "Email", tag: "input" },
      { id: "e3", role: "combobox", name: "Color", tag: "select" },
      { id: "e4", role: "radio", name: "A", tag: "input" },
    ],
  });
}

/** An evaluate that answers the ref-resolve script with a live selector and
 *  every other script with `other`. */
function resolvesThen(other: unknown) {
  return (expr: string): unknown =>
    expr === resolveRefScript("e2") || expr === resolveRefScript("e4", { enabled: true }) ? "input" : other;
}

interface Case {
  argv: string[];
  handlers?: FakeHandlers;
  stderr: string;
}

// Every user error bowser raises, by throw site, through run() and a fake
// daemon. Each must keep its text and exit 1. The ones raised in
// connectOrSpawn are below; the version refusal (F2) is in
// tests/lifecycle.test.ts, the Bun guard in tests/daemon.test.ts.
const USER_ERRORS: Case[] = [
  { argv: ["bogus"], stderr: "unknown command: bogus" },
  { argv: ["bogus", "--help"], stderr: "unknown command: bogus" },
  { argv: ["snapshot", "--bogus"], stderr: "unknown flag: --bogus" },
  { argv: ["snapshot", "-Z"], stderr: "unknown flag: -Z" },
  { argv: ["eval", "1", "2"], stderr: "usage: too many arguments for 'eval': expected 1, received 2" },
  { argv: ["mcp"], stderr: "usage: run 'bowser mcp' as a top-level subcommand" },
  { argv: ["--session=../x", "open"], stderr: `usage: session name may use only letters, digits, '.', '_' and '-', and must not start with '.' or '-', got "../x"` },
  { argv: ["--session=nopage", "click", "e1"], stderr: "no open page. Run 'bowser open <url>' first." },
  { argv: ["click", "@e1"], stderr: "expected a ref like 'e1', got '@e1'. Run 'bowser snapshot' first." },
  { argv: ["click", "e9"], stderr: "ref 'e9' not found in last snapshot of session 'codes'. Run 'bowser snapshot' to refresh." },
  { argv: ["click", "e1"], handlers: { evaluate: () => null }, stderr: "ref 'e1' not found in the current page snapshot. Try capturing new snapshot." },
  { argv: ["click", "e1"], handlers: { evaluate: () => ({ disabled: true }) }, stderr: "ref 'e1' is disabled" },
  { argv: ["check", "e1"], stderr: "ref 'e1' is not a checkbox or radio button (button)" },
  { argv: ["select", "e1", "a"], stderr: "ref 'e1' is not a <select> element (button)" },
  { argv: ["fill", "e1", "a"], stderr: "ref 'e1' is not an <input>, <textarea> or contenteditable element (button)" },
  { argv: ["fill", "e2"], stderr: "usage: bowser fill <ref> <text> or bowser fill <ref> --stdin" },
  { argv: ["fill", "e2", "a", "--stdin"], stderr: "usage: bowser fill <ref> <text> or bowser fill <ref> --stdin (not both)" },
  { argv: ["fill", "e2", "a"], handlers: { evaluate: resolvesThen({ outcome: "disabled" }) }, stderr: "ref 'e2' is not an editable element (disabled)" },
  { argv: ["fill", "e2", "a"], handlers: { evaluate: resolvesThen({ outcome: "readonly" }) }, stderr: "ref 'e2' is not an editable element (readonly)" },
  { argv: ["fill", "e2", "a"], handlers: { evaluate: resolvesThen({ outcome: "nan" }) }, stderr: "ref 'e2' needs a number (input[type=number])" },
  { argv: ["fill", "e2", "a"], handlers: { evaluate: resolvesThen({ outcome: "rejected", type: "date" }) }, stderr: "ref 'e2' did not accept the value for input[type=date]" },
  { argv: ["select", "e3", "z"], handlers: { evaluate: () => "select", select: () => false }, stderr: `ref 'e3' has no option "z"` },
  { argv: ["uncheck", "e4"], handlers: { evaluate: resolvesThen(undefined), uncheck: () => false }, stderr: "ref 'e4' is a radio button; select another option in its group to uncheck it" },
  { argv: ["press", ""], stderr: "usage: bowser press <key>" },
  { argv: ["resize", "0", "10"], stderr: "usage: bowser resize <width> <height>" },
  { argv: ["eval", ""], stderr: "usage: bowser eval <expression>" },
  { argv: ["run-code", ""], stderr: "usage: bowser run-code <code>" },
  { argv: ["run-code", "async page => 1"], handlers: { evaluate: () => ({ fn: true }) }, stderr: "run-code runs JavaScript in the page and has no Playwright 'page'; write statements and use return" },
  { argv: ["snapshot", "--depth=-1"], stderr: "usage: --depth=N requires a non-negative integer (got '-1')" },
  { argv: ["open", "--profile="], stderr: "usage: --profile needs a directory, e.g. --profile=./profile" },
  { argv: ["open", "--profile=/p1"], handlers: { state: () => ({ url: "", title: "", profile: "/p2" }) }, stderr: "usage: session 'codes' is already open with a different profile; run 'bowser close' first" },
  { argv: ["goto", ""], stderr: "usage: bowser goto <url>" },
  { argv: ["state-save", ""], stderr: "usage: bowser state-save <file>" },
  { argv: ["state-load", ""], stderr: "usage: bowser state-load <file>" },
  // F5: every problem with the file is the user's.
  { argv: ["state-load", "/nonexistent/bowser-state.json"], stderr: "state-load: file not found: /nonexistent/bowser-state.json" },
  { argv: ["localstorage-get", ""], stderr: "usage: bowser localstorage-get <key>" },
  { argv: ["sessionstorage-set", ""], stderr: "usage: bowser sessionstorage-set <key> <value>" },
  { argv: ["sessionstorage-delete", ""], stderr: "usage: bowser sessionstorage-delete <key>" },
  // #60: a missing required positional, refused by run() from the registry.
  { argv: ["select", "e3"], stderr: "usage: bowser select <ref> <value>" },
  { argv: ["localstorage-set", "k"], stderr: "usage: bowser localstorage-set <key> <value>" },
];

// Runtime errors: the page, the daemon or the file system failed, not the
// command line. Exit 2.
const RUNTIME_ERRORS: Case[] = [
  { argv: ["eval", "x"], handlers: { evaluate: () => { throw new Error("usage: from the page"); } }, stderr: "usage: from the page" },
  { argv: ["click", "e1"], handlers: { evaluate: () => "button", click: () => { throw new Error("ref 'e1' not found by the daemon"); } }, stderr: "ref 'e1' not found by the daemon" },
  { argv: ["open", "https://x/"], handlers: { state: () => ({ url: "about:blank", title: "" }) }, stderr: "navigate: page did not load https://x/ (ended on about:blank)" },
];

describe("exit codes by throw site, through run()", () => {
  beforeAll(async () => { await seed("codes"); });

  for (const { argv, handlers, stderr } of USER_ERRORS) {
    test(`user error, exit 1: ${JSON.stringify(argv)}`, async () => {
      expect(await failure(["--session=codes", ...argv], handlers)).toEqual({ stderr: `bowser: ${stderr}`, code: 1 });
    });
  }
  for (const { argv, handlers, stderr } of RUNTIME_ERRORS) {
    test(`runtime error, exit 2: ${JSON.stringify(argv)}`, async () => {
      expect(await failure(["--session=codes", ...argv], handlers)).toEqual({ stderr: `bowser: ${stderr}`, code: 2 });
    });
  }
});

describe("user errors raised outside a command's run", () => {
  const code = async (p: Promise<unknown> | (() => unknown)) => {
    try {
      await (typeof p === "function" ? p() : p);
      return "no failure";
    } catch (err) {
      return reportFailure(err);
    }
  };

  test("fill --stdin from a terminal", async () => {
    expect(await code(readStdin({ isTTY: true }, async () => "x"))).toEqual({
      stderr: "bowser: usage: --stdin reads piped input, not a terminal: op read op://vault/item/password | bowser fill e4 --stdin",
      code: 1,
    });
  });

  test("an MCP call that passes a CLI-only flag", async () => {
    expect(await code(() => toArgv(findCommand("fill")!, { ref: "e2", stdin: true }))).toEqual({
      stderr: "bowser: usage: --stdin is not available over MCP",
      code: 1,
    });
  });

  // platform: "linux", so a regression cannot spawn a daemon here.
  test("connectOrSpawn off macOS", async () => {
    expect(await code(connectOrSpawn("codes-linux", { platform: "linux" }))).toEqual({
      stderr: "bowser: bowser requires macOS (WebKit)",
      code: 1,
    });
  });

  test("connectOrSpawn on a session whose browser exited", async () => {
    await saveState({ name: "codes-gone", url: "http://x/", title: "", refs: [], updatedAt: Date.now() });
    await Bun.write(pidPath("codes-gone"), "99999");
    expect(await code(connectOrSpawn("codes-gone", { platform: "linux" }))).toEqual({
      stderr: "bowser: session 'codes-gone' is not open (its browser exited); run 'bowser open'",
      code: 1,
    });
  });

  test("connectOrSpawn with spawning off: a runtime error", async () => {
    expect(await code(connectOrSpawn("codes-none", { spawn: false }))).toEqual({
      stderr: "bowser: no daemon for session 'codes-none'",
      code: 2,
    });
  });
});
