// --help is generated from the registry. These pin the parts an agent reads:
// every command appears exactly once, with its argument shape and summary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMMANDS, SCHEMAS, type Command } from "../src/cli/registry.ts";
import { helpRequested } from "../src/cli/parser.ts";
import { renderHelp, usageOf } from "../src/cli/help.ts";
import { run } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { saveState, sessionDir } from "../src/state.ts";
import { fakeClient } from "./helpers/fake-client.ts";

const findCommandSummary = (name: string) => COMMANDS.find((c) => c.name === name)!.summary;

const HELP = renderHelp(COMMANDS);

/** No real command has a usage too wide for the summary column. */
const PICK: Command = {
  name: "pick",
  summary: "Pick a size",
  positional: [{ name: "first-choice", required: true }, { name: "second-choice", required: false }],
  flags: [{ name: "until", kind: "string" }],
  run: async () => "",
};
const WIDE_HELP = renderHelp([...COMMANDS, PICK]);

describe("generated help", () => {
  test("lists every command exactly once, in registry order", () => {
    const listed = HELP.split("\n")
      .map((l) => l.match(/^  ([a-z][a-z-]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(listed).toEqual(COMMANDS.map((c) => c.name));
  });

  test("shows required positionals in <> and optional in []", () => {
    expect(HELP).toContain("goto <url>");
    expect(HELP).toContain("open [url]");
    expect(HELP).toContain("select <ref> <value>");
  });

  test("fill shows both forms: <text> or --stdin", () => {
    const line = HELP.split("\n").find((l) => l.startsWith("  fill "))!;
    expect(line).toContain("fill <ref> [text] [--stdin]");
    expect(HELP).toContain(findCommandSummary("fill"));
    expect(findCommandSummary("fill")).toContain("--stdin");
  });

  test("shows flags, with a value placeholder for string flags", () => {
    expect(HELP).toContain("[--all]");
    expect(HELP).toContain("[--filename=<filename>]");
  });

  test("summaries line up in one column, narrow enough to leave half the width", () => {
    const cols = new Set<number>();
    for (const c of COMMANDS) {
      const line = HELP.split("\n").find((l) => l.includes(c.summary));
      cols.add(line!.indexOf(c.summary));
    }
    expect(cols.size).toBe(1);
    expect([...cols][0]).toBeLessThanOrEqual(40);
  });

  test("a usage too wide for the column wraps instead of widening it", () => {
    const lines = WIDE_HELP.split("\n");
    const col = lines.find((l) => l.includes("Reload the current page"))!.indexOf("Reload");
    const i = lines.findIndex((l) => l.startsWith("  pick "));
    expect(lines[i]!.length).toBeGreaterThan(col);
    expect(lines[i + 1]).toBe(" ".repeat(col) + "Pick a size");
  });

  test("every summary appears", () => {
    for (const c of COMMANDS) expect(HELP).toContain(c.summary);
  });

  test("keeps the header and the global flags block", () => {
    expect(HELP.startsWith("bowser — drop-in playwright-cli alternative for AI agents")).toBe(true);
    expect(HELP).toContain("Global flags:");
    expect(HELP).toContain('-s, --session <name>     session name (default: "default")');
    expect(HELP).toContain("--json               machine-readable output");
    expect(HELP).toContain("-h, --help               show this help");
  });
});

// `<cmd> --help` prints that command's help and runs nothing (spec F1,
// docs/superpowers/specs/2026-09-26-p0-hangs-design.md). `close --help` used
// to close the session and `open --help` to open one.
describe("per-command help", () => {
  let tmp: string;
  let origHome: string | undefined;
  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-help-"));
    process.env.HOME = tmp;
  });
  afterAll(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  /** A context whose every daemon connection is counted, and refused. */
  function counting() {
    const seen = { connects: 0 };
    const base: Partial<CommandContext> = {
      connect: async () => {
        seen.connects++;
        throw new Error("help must not connect to a daemon");
      },
      readStdin: async () => {
        throw new Error("help must not read stdin");
      },
    };
    return { seen, base };
  }

  for (const c of COMMANDS) {
    test(`${c.name} --help prints its usage, summary and flags, and connects to nothing`, async () => {
      const { seen, base } = counting();
      const out = await run([c.name, "--help"], base);
      expect(out.split("\n")[0]).toBe(`bowser ${usageOf(c)}`);
      expect(out).toContain(c.summary);
      for (const p of c.positional) expect(out).toContain(p.required ? `<${p.name}>` : `[${p.name}]`);
      for (const f of c.flags) expect(out).toContain(`--${f.name}`);
      expect(out).not.toContain("Commands:");
      expect(seen.connects).toBe(0);
    });
  }

  test("-h before the command, and --help after its arguments, both print its help", async () => {
    const { seen, base } = counting();
    const close = COMMANDS.find((c) => c.name === "close")!;
    expect((await run(["-h", "close"], base)).split("\n")[0]).toBe(`bowser ${usageOf(close)}`);
    expect((await run(["-s", "t1", "close", "-h"], base)).split("\n")[0]).toBe(`bowser ${usageOf(close)}`);
    const fill = COMMANDS.find((c) => c.name === "fill")!;
    expect((await run(["fill", "e1", "hello", "--help"], base)).split("\n")[0]).toBe(`bowser ${usageOf(fill)}`);
    expect(seen.connects).toBe(0);
  });

  test("an unknown flag beside --help does not hide it; without --help it is still an error", async () => {
    const { seen, base } = counting();
    const close = COMMANDS.find((c) => c.name === "close")!;
    expect((await run(["close", "--bogus", "--help"], base)).split("\n")[0]).toBe(`bowser ${usageOf(close)}`);
    expect((await run(["close", "-x", "-h"], base)).split("\n")[0]).toBe(`bowser ${usageOf(close)}`);
    expect(seen.connects).toBe(0);
    await expect(run(["close", "--bogus"], base)).rejects.toThrow("unknown flag: --bogus");
    await expect(run(["fill", "e1", "--", "--bogus", "--help"], base)).rejects.toThrow("no open page");
  });

  // -h as a string flag's separate value is that value, as before per-command
  // help existed: the scan for help must skip what the parser consumes.
  test("snapshot --filename -h writes a file named -h", async () => {
    const snap = {
      url: "https://x", title: "X",
      tree: [{ role: "link", name: "Home", ref: "e1", props: { url: "/" }, children: [] }],
      refs: [{ id: "e1", selector: "a", role: "link", name: "Home", tag: "a" }],
    };
    const c = fakeClient({ evaluate: () => snap });
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(await run(["-s", "snap", "snapshot", "--filename", "-h"], { connect: async () => c })).toBe("wrote -h");
      expect(await Bun.file(join(tmp, "-h")).text()).toContain('link "Home" [ref=e1]');
    } finally {
      process.chdir(cwd);
    }
  });

  test("-s -h open takes -h as the session name", async () => {
    const { base } = counting();
    // open runs with session "-h", which session-name validation refuses, as
    // it did before per-command help existed; help would have returned.
    await expect(run(["-s", "-h", "open", "https://example.com/"], base)).rejects.toThrow('got "-h"');
    expect(helpRequested(SCHEMAS, ["-s", "-h", "open"])).toBe(false);
    expect(helpRequested(SCHEMAS, ["snapshot", "--filename", "-h"])).toBe(false);
  });

  test("an unknown flag consumes nothing: close --bogus -h is help", async () => {
    const { seen, base } = counting();
    const close = COMMANDS.find((c) => c.name === "close")!;
    expect((await run(["close", "--bogus", "-h"], base)).split("\n")[0]).toBe(`bowser ${usageOf(close)}`);
    expect(helpRequested(SCHEMAS, ["mcp", "--bogus", "-h"])).toBe(true);
    expect(seen.connects).toBe(0);
  });

  test("close --help leaves the session in place", async () => {
    const { base } = counting();
    await saveState({ name: "keep", url: "https://x", title: "X", refs: [], updatedAt: 1 });
    await run(["-s", "keep", "close", "--help"], base);
    expect(existsSync(sessionDir("keep"))).toBe(true);
  });

  test("with no command, --help prints the general help", async () => {
    const { seen, base } = counting();
    expect(await run(["--help"], base)).toBe(HELP);
    expect(await run(["-h"], base)).toBe(HELP);
    expect(seen.connects).toBe(0);
  });

  test("after --, --help is data: the command runs", async () => {
    const { base } = counting();
    // No session state, so fill gets as far as loading its ref and fails there.
    await expect(run(["fill", "e1", "--", "--help"], base)).rejects.toThrow("no open page");
  });

  // An unknown flag next to --help still gets the help: `mcp --bogus --help`
  // once started the server, because the parse error hid the --help.
  test.each([
    [["close", "--help"]],
    [["mcp", "--help"]],
    [["close", "--bogus", "--help"]],
    [["mcp", "--bogus", "--help"]],
    [["mcp", "-x", "-h"]],
  ])("the CLI entry prints help and exits 0 for %j, starting no server", async (argv) => {
    const name = argv[0]!;
    {
      const proc = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...argv],
        env: { ...process.env, HOME: tmp },
        // A pipe held open: a started MCP server would wait on it forever.
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 5_000);
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      clearTimeout(timer);
      const cmd = COMMANDS.find((c) => c.name === name)!;
      expect(stdout.split("\n")[0]).toBe(`bowser ${usageOf(cmd)}`);
      expect(code).toBe(0);
    }
  }, 15_000);
});
