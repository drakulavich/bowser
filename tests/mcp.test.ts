// Unit tests for the MCP bridge (src/mcp.ts).
//
// The protocol core (handleMcpRequest) takes an injected `run`, so these tests
// exercise the full request/response surface with NO real stdio or daemon.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTools,
  createMcpServer,
  toArgv,
  handleMcpRequest,
  handleMcpLine,
  type McpDeps,
} from "../src/mcp.ts";
import { parse } from "../src/cli/parser.ts";
import { SCHEMAS } from "../src/cli/registry.ts";
import { findCommand } from "../src/cli/registry.ts";
import { run } from "../src/cli.ts";
import { resolveRefScript } from "../src/page-scripts.ts";
import { saveState } from "../src/state.ts";
import { fakeClient } from "./helpers/fake-client.ts";

/** Number of commands opted out of the MCP tool set via `mcp: false`. */
const MCP_EXCLUDED_COUNT = SCHEMAS.commands.filter((c) => findCommand(c.name)!.mcp === false).length;

const okRun = (out = '{"ok":true}'): McpDeps => ({
  run: async () => out,
  version: "9.9.9",
});

/** Feed raw lines to the server loop and return every response it wrote,
 *  once every accepted call has finished. */
async function serve(lines: string[], deps: McpDeps = okRun()): Promise<any[]> {
  const writes: string[] = [];
  const server = createMcpServer(deps, (line) => { writes.push(line); });
  for (const line of lines) server.accept(line);
  await server.idle();
  await new Promise((r) => setTimeout(r, 0));
  return writes.map((w) => JSON.parse(w));
}

function schema(name: string) {
  const s = SCHEMAS.commands.find((c) => c.name === name);
  if (!s) throw new Error(`no schema ${name}`);
  return s;
}

describe("buildTools", () => {
  test("generates one tool per non-excluded command", () => {
    const tools = buildTools();
    expect(tools.length).toBe(SCHEMAS.commands.length - MCP_EXCLUDED_COUNT);
  });

  test("excludes mcp", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).not.toContain("mcp");
    expect(names).toContain("open");
    expect(names).toContain("fill");
  });

  test("open inputSchema: optional positional, optional session, typed flags", () => {
    const tool = buildTools().find((t) => t.name === "open")!;
    const s = tool.inputSchema;
    expect(s.type).toBe("object");
    expect(s.required).toEqual([]);
    expect(s.properties.session).toEqual({ type: "string", description: expect.any(String) });
    expect(s.properties.url.type).toBe("string");
    expect(s.properties.persistent.type).toBe("boolean");
    expect(s.properties.profile.type).toBe("string");
  });

  test("select inputSchema: required positionals", () => {
    const s = buildTools().find((t) => t.name === "select")!.inputSchema;
    expect(s.required).toEqual(["ref", "value"]);
    expect(s.required).not.toContain("session");
  });

  test("every tool carries a non-empty description", () => {
    for (const t of buildTools()) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe("toArgv", () => {
  test("reconstructs session, --json, typed flags, then -- and positionals (schema order)", () => {
    const argv = toArgv(schema("open"), {
      url: "https://x.com/",
      profile: "./p",
      persistent: true,
      session: "s1",
    });
    expect(argv).toEqual([
      "--session", "s1",
      "--json",
      "open",
      "--persistent",
      "--profile=./p",
      "--", "https://x.com/",
    ]);
  });

  test("omits a false boolean flag and an absent session", () => {
    const argv = toArgv(schema("open"), {
      url: "https://x.com/",
      persistent: false,
    });
    expect(argv).toEqual(["--json", "open", "--", "https://x.com/"]);
  });

  test("no-positional, no-flag command", () => {
    expect(toArgv(schema("list"), {})).toEqual(["--json", "list"]);
  });

  // F4: the CLI refuses a word past a command's declared positionals. A tool
  // call cannot trip that: toArgv takes positionals from the schema only.
  test("never passes more positionals than a command declares, whatever the call sends", () => {
    for (const s of SCHEMAS.commands) {
      const args: Record<string, unknown> = { extra: "x", _0: "y" };
      for (const p of s.positional) args[p.name] = "v";
      const argv = toArgv(s, args);
      expect(parse(SCHEMAS, argv).positional.length).toBe(s.positional.length);
    }
  });

  test("a positional that looks like a flag goes after --", () => {
    expect(toArgv(schema("fill"), { ref: "e1", text: "--json" })).toEqual(["--json", "fill", "--", "e1", "--json"]);
  });
});

describe("handleMcpRequest — handshake", () => {
  test("initialize echoes protocol version and reports serverInfo", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      okRun(),
    );
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo.name).toBe("bowser");
    expect(res.result.serverInfo.version).toBe("9.9.9");
  });

  test("initialize without a known version falls back to the server default", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      okRun(),
    );
    expect(typeof res.result.protocolVersion).toBe("string");
    expect(res.result.protocolVersion.length).toBeGreaterThan(0);
  });

  test("notifications get NO response", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      okRun(),
    );
    expect(res).toBeNull();
  });
});

describe("handleMcpRequest — tools/list", () => {
  test("returns the generated tool set", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      okRun(),
    );
    expect(res.result.tools.length).toBe(SCHEMAS.commands.length - MCP_EXCLUDED_COUNT);
  });
});

describe("handleMcpRequest — tools/call", () => {
  test("success: reconstructs argv, returns text content", async () => {
    let captured: string[] = [];
    const deps: McpDeps = { run: async (a) => { captured = a; return '{"ok":true,"url":"u"}'; }, version: "9.9.9" };
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "goto", arguments: { url: "https://e.com" } } },
      deps,
    );
    expect(captured).toEqual(["--json", "goto", "--", "https://e.com"]);
    expect(res.result.content).toEqual([{ type: "text", text: '{"ok":true,"url":"u"}' }]);
    expect(res.result.isError).toBeFalsy();
  });

  test("command error maps to a tool error result (not a JSON-RPC error)", async () => {
    const deps: McpDeps = { run: async () => { throw new Error("no open page. Run 'bowser open <url>' first."); }, version: "9.9.9" };
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "snapshot", arguments: {} } },
      deps,
    );
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("no open page");
  });

  // F38: MCP outputs are the --json JSON, for snapshot with a filename too.
  test("snapshot with a filename answers {ok, filename}, and the file holds the text", async () => {
    // snapshot saves the session's refs: keep them out of the real ~/.bowser.
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "bowser-mcp-snap-")));
    const prevHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const file = join(dir, "snap.md");
      const snap = { url: "https://x", title: "X", tree: [{ role: "button", name: "Go", ref: "e1", children: [] }], refs: [] };
      const connect = async () => fakeClient({ evaluate: () => snap });
      const deps: McpDeps = { run: (argv) => run(argv, { connect }), version: "9.9.9" };
      const res: any = await handleMcpRequest(
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "snapshot", arguments: { session: "m38", filename: file } } },
        deps,
      );
      expect(res.result.isError).toBeFalsy();
      expect(JSON.parse(res.result.content[0].text)).toEqual({ ok: true, filename: file });
      expect(await Bun.file(file).text()).toStartWith("### Page\n- Page URL: https://x\n");
      expect(existsSync(join(dir, ".bowser", "sessions", "m38", "state.json"))).toBe(true);
    } finally {
      process.env.HOME = prevHome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed tool call's error text carries the dialogs the command answered", async () => {
    const dismissed = { type: "confirm" as const, message: "sure?", state: "dismissed" as const, unanswered: true as const };
    const connect = async () => fakeClient({ evaluate: () => { throw new Error("Error: boom"); } }, { dialogs: [dismissed] });
    const deps: McpDeps = { run: (argv) => run(argv, { connect }), version: "9.9.9" };
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "eval", arguments: { expression: "confirm('sure?'); throw 1" } } },
      deps,
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe(
      'Error: boom\n### Modal state\n- ["confirm" dialog with message "sure?"]: dismissed (run dialog-accept before the action to accept it)',
    );
  });

  test("unknown tool → tool error result", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nonexistent", arguments: {} } },
      okRun(),
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("nonexistent");
  });

  for (const stdin of [true, false, "true"]) {
    test(`fill with stdin: ${JSON.stringify(stdin)} is a usage error and never runs the command`, async () => {
      let ran = false;
      const deps: McpDeps = { run: async () => { ran = true; return "{}"; }, version: "9.9.9" };
      const res: any = await handleMcpRequest(
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "fill", arguments: { ref: "e1", stdin } } },
        deps,
      );
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/^usage: .*--stdin/);
      expect(ran).toBe(false);
    });
  }

  test("an excluded command is not callable as a tool", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mcp", arguments: {} } },
      okRun(),
    );
    expect(res.result.isError).toBe(true);
  });
});

describe("handleMcpRequest — errors", () => {
  test("unknown method → -32601", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 7, method: "foo/bar" },
      okRun(),
    );
    expect(res.error.code).toBe(-32601);
  });

  test("malformed JSON line → -32700 with id null", async () => {
    const res: any = await handleMcpLine("{not json", okRun());
    expect(res.error.code).toBe(-32700);
    expect(res.id).toBeNull();
  });
});

describe("descriptions drift-guard", () => {
  test("every exposed tool has a non-empty summary as its description", () => {
    for (const t of buildTools()) {
      expect(t.description.length).toBeGreaterThan(0);
      const cmd = findCommand(t.name)!;
      expect(t.description).toBe(cmd.mcpSummary ?? cmd.summary);
    }
  });

  test("fill offers text but not stdin", () => {
    const fill = buildTools().find((t) => t.name === "fill")!;
    expect(fill.inputSchema.properties).toHaveProperty("text");
    expect(fill.inputSchema.properties).not.toHaveProperty("stdin");
  });

  test("fill requires ref and text over MCP, though the CLI can take --stdin instead of text", () => {
    const fill = buildTools().find((t) => t.name === "fill")!;
    expect(fill.inputSchema.required).toEqual(["ref", "text"]);
    expect(findCommand("fill")!.positional.find((p) => p.name === "text")!.required).toBe(false);
  });

  test("fill's MCP description does not mention --stdin, which MCP does not offer", () => {
    const fill = buildTools().find((t) => t.name === "fill")!;
    expect(fill.description).toBe("Fill the element with the given ref with text");
    expect(fill.description).not.toContain("stdin");
    expect(findCommand("fill")!.summary).toContain("--stdin");
  });

  test("mcp is not exposed as a tool", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).not.toContain("mcp");
  });
});

describe("MCP positionals are data, never flags", () => {
  for (const text of ["--json", "--stdin", "-5", "--"]) {
    test(`fill with text ${JSON.stringify(text)} types exactly that`, async () => {
      const home = await mkdtemp(join(tmpdir(), "bowser-mcp-dash-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await saveState({ name: "dash", url: "https://x", title: "X", updatedAt: Date.now(),
          refs: [{ id: "e1", role: "textbox", name: "Email", tag: "input" }] });
        const c = fakeClient({ evaluate: (e) => (e === resolveRefScript("e1") ? "input" : undefined) });
        const deps: McpDeps = {
          run: (argv) => run(argv, { connect: async () => c, readStdin: async () => { throw new Error("read stdin"); } }),
          version: "9.9.9",
        };
        const res: any = await handleMcpRequest(
          { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "fill", arguments: { ref: "e1", text, session: "dash" } } },
          deps,
        );
        expect(res.result.isError).toBeFalsy();
        expect(JSON.parse(res.result.content[0].text)).toEqual({ ok: true, ref: "e1" });
        expect(c.calls.filter(([op]) => op === "type")).toEqual([["type", [text]]]);
      } finally {
        process.env.HOME = prevHome;
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

describe("bowser mcp never reads its own stdin for a command", () => {
  test("fill with text \"--stdin\" is text, not the flag, and the server keeps answering", async () => {
    // The server's stdin is the JSON-RPC stream: parsing the text as the flag
    // would read it, swallowing later requests and hanging this one. toArgv's
    // `--` keeps it a positional, so the call fails on the empty HOME instead.
    const home = await mkdtemp(join(tmpdir(), "bowser-mcp-stdin-"));
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
      {
        env: { ...process.env, HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fill", arguments: { ref: "e1", text: "--stdin" } } };
      proc.stdin.write(JSON.stringify(call) + "\n");
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      proc.stdin.flush();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 5000;
      while (buf.split("\n").filter(Boolean).length < 2 && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined })),
        ]);
        if (next.done) break;
        buf += decoder.decode(next.value);
      }
      // Responses may come in any order (F36): the ping does not wait.
      const lines = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const first = lines.find((m) => m.id === 1);
      const second = lines.find((m) => m.id === 2);
      expect(first?.id).toBe(1);
      expect(first?.result.isError).toBe(true);
      expect(first?.result.content[0].text).toContain("no open page");
      expect(second).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    } finally {
      proc.kill();
      await proc.exited;
      await rm(home, { recursive: true, force: true });
    }
  });
});

// F37: the server writes where the client can find it. An unwritable cwd
// (or `/`) is swapped for <os.tmpdir()>/bowser-mcp at start, and every file
// output is reported by its absolute path.
describe("bowser mcp resolves file outputs against a writable directory", () => {
  const HELPER = join(import.meta.dir, "helpers", "mcp-fake-daemon.ts");

  /** Start the server in `cwd` with its own TMPDIR, send one tools/call, and
   *  return the tool result's text. */
  async function callIn(cwd: string, tmpDir: string, args: Record<string, string>): Promise<{ isError?: boolean; text: string }> {
    const home = await mkdtemp(join(tmpdir(), "bowser-mcp-cwd-home-"));
    const proc = Bun.spawn([process.execPath, HELPER], {
      cwd,
      env: { ...process.env, HOME: home, TMPDIR: tmpDir },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: { session: "m37", ...args } } };
      proc.stdin.write(JSON.stringify(call) + "\n");
      proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      const res = JSON.parse(out.split("\n").find(Boolean) ?? "{}");
      return { isError: res.result?.isError, text: res.result?.content?.[0]?.text ?? JSON.stringify(res) };
    } finally {
      proc.kill();
      await proc.exited;
      await rm(home, { recursive: true, force: true });
    }
  }

  test("an unwritable cwd: a default screenshot lands in <os.tmpdir()>/bowser-mcp, reported absolute", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "bowser-mcp-cwd-")));
    const locked = join(root, "locked");
    const tmpDir = join(root, "tmp");
    await mkdir(locked);
    await mkdir(tmpDir);
    chmodSync(locked, 0o555);
    try {
      const res = await callIn(locked, tmpDir, {});
      expect(res.isError).toBeFalsy();
      const expected = join(tmpDir, "bowser-mcp", "screenshot-m37.png");
      expect(JSON.parse(res.text)).toEqual({ ok: true, filename: expected });
      expect(existsSync(expected)).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cwd /: the same directory", async () => {
    const tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "bowser-mcp-root-")));
    try {
      const res = await callIn("/", tmpDir, {});
      expect(JSON.parse(res.text)).toEqual({ ok: true, filename: join(tmpDir, "bowser-mcp", "screenshot-m37.png") });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a writable cwd is kept, and an absolute path is used as given", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "bowser-mcp-keep-")));
    try {
      const rel = await callIn(root, root, { filename: "shot.png" });
      expect(JSON.parse(rel.text)).toEqual({ ok: true, filename: join(root, "shot.png") });
      const target = join(root, "abs", "given.png");
      const abs = await callIn("/", root, { filename: target });
      expect(JSON.parse(abs.text)).toEqual({ ok: true, filename: target });
      expect(existsSync(target)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP fill and type never echo the entered text", () => {
  const SECRET = "hunter2-S3cr3t!";
  for (const [tool, args] of [
    ["fill", { ref: "e1", text: SECRET, session: "echo" }],
    ["type", { text: SECRET, session: "echo" }],
  ] as const) {
    test(`the ${tool} tool result does not contain the text`, async () => {
      const home = await mkdtemp(join(tmpdir(), "bowser-mcp-echo-"));
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await saveState({ name: "echo", url: "https://x", title: "X", updatedAt: Date.now(),
          refs: [{ id: "e1", role: "textbox", name: "Password", tag: "input" }] });
        const c = fakeClient({ evaluate: (e) => (e === resolveRefScript("e1") ? "input" : undefined) });
        const deps: McpDeps = { run: (argv) => run(argv, { connect: async () => c }), version: "9.9.9" };
        const res: any = await handleMcpRequest(
          { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: tool, arguments: args } },
          deps,
        );
        expect(res.result.isError).toBeFalsy();
        expect(c.calls).toContainEqual(["type", [SECRET]]);
        expect(JSON.stringify(res)).not.toContain(SECRET);
      } finally {
        process.env.HOME = prevHome;
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

describe("MCP fill and type errors never carry the entered text", () => {
  const SECRET = "hunter2-S3cr3t!";
  const cases = [
    ["fill", { ref: "e1", text: SECRET, session: "echoerr" }],
    ["type", { text: SECRET, session: "echoerr" }],
  ] as const;
  const call = async (tool: string, args: object, message: string) => {
    const home = await mkdtemp(join(tmpdir(), "bowser-mcp-echoerr-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await saveState({ name: "echoerr", url: "https://x", title: "X", updatedAt: Date.now(),
        refs: [{ id: "e1", role: "textbox", name: "Password", tag: "input" }] });
      const c = fakeClient({
        evaluate: (e) => (e === resolveRefScript("e1") ? "input" : undefined),
        type: () => { throw new Error(message); },
      });
      const deps: McpDeps = { run: (argv) => run(argv, { connect: async () => c }), version: "9.9.9" };
      const res: any = await handleMcpRequest(
        { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: tool, arguments: args } },
        deps,
      );
      expect(res.result.isError).toBe(true);
      return res.result.content[0].text as string;
    } finally {
      process.env.HOME = prevHome;
      await rm(home, { recursive: true, force: true });
    }
  };
  for (const [tool, args] of cases) {
    test(`the ${tool} tool's isError text withholds a browser error containing the text`, async () => {
      expect(await call(tool, args, `failed: ${SECRET}`)).toBe(
        `${tool}: the browser's error message was withheld because it contained the entered text`,
      );
    });
    test(`the ${tool} tool's isError text passes an error without the text through`, async () => {
      expect(await call(tool, args, "failed: boom")).toBe("failed: boom");
    });
  }
});

// F39: the server answers with a version it supports: the client's when it is
// one, else the latest. 2025-03-26 is not one: it requires batches (F40).
// 2026-07-28 is not one either: it drops the initialize handshake.
describe("MCP server: initialize negotiates the protocol version", () => {
  const init = (protocolVersion?: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: protocolVersion === undefined ? {} : { protocolVersion } });
  for (const v of ["2025-11-25", "2025-06-18", "2024-11-05"]) {
    test(`a supported version (${v}) is echoed`, async () => {
      const [res] = await serve([init(v)]);
      expect(res.result.protocolVersion).toBe(v);
    });
  }
  for (const v of ["1999-bogus", "2025-03-26", "2026-07-28", "", 42, undefined]) {
    test(`${JSON.stringify(v)} gets the latest supported version, 2025-11-25`, async () => {
      const [res] = await serve([init(v)]);
      expect(res.result.protocolVersion).toBe("2025-11-25");
    });
  }

  // The stateless 2026-07-28 revision is not implemented. Its client probes
  // with server/discover and falls back to initialize on -32601.
  test("server/discover is an unknown method (-32601), so a 2026 client falls back", async () => {
    const [res] = await serve([JSON.stringify({ jsonrpc: "2.0", id: 9, method: "server/discover", params: {} })]);
    expect(res).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found: server/discover" } });
  });
});

// F40: a line that is not a request object gets -32600 with id null; before,
// it was taken for a notification and got nothing, and a client waiting on an
// id inside a batch hung. One error for a whole batch, whose calls never run.
describe("MCP server: a batch or a non-object message is an invalid request", () => {
  const INVALID = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const cases: Array<[string, string]> = [
    ["a batch array", JSON.stringify([{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", id: 7, method: "ping" }])],
    ["an empty array", "[]"],
    ["a number", "123"],
    ["a string", '"str"'],
    ["null", "null"],
    ["true", "true"],
  ];
  for (const [what, line] of cases) {
    test(`${what} gets one -32600 with id null`, async () => {
      expect(await serve([line])).toEqual([INVALID]);
    });
  }

  test("a batched tools/call never runs, and the next line is still answered", async () => {
    let ran = false;
    const deps: McpDeps = { run: async () => { ran = true; return "{}"; }, version: "9.9.9" };
    const batch = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list", arguments: {} } }]);
    const res = await serve([batch, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })], deps);
    expect(res).toEqual([INVALID, { jsonrpc: "2.0", id: 2, result: {} }]);
    expect(ran).toBe(false);
  });
});

// F42: tool arguments are checked against the tool's own inputSchema, and a
// wrong one is an isError usage result the model can correct (SEP-1303).
// Before, `session: 42` ran on "default", an object went to the page as
// "[object Object]", `persistent: "false"` or `1` was silently dropped, and an
// unknown key was ignored. A finite number is taken where the schema says
// string, so `resize {width: 800}` keeps working.
describe("MCP server: tool arguments are checked against the tool's schema", () => {
  /** Send one tools/call line; return the result and the argv run got, if any. */
  async function callLine(line: string): Promise<{ result: any; argv: string[] | null }> {
    let argv: string[] | null = null;
    const deps: McpDeps = { run: async (a) => { argv = a; return '{"ok":true}'; }, version: "9.9.9" };
    const [res] = await serve([line], deps);
    return { result: res.result, argv };
  }
  const call = (name: string, args: unknown) =>
    callLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));

  const refused: Array<[string, string, unknown, RegExp]> = [
    ["a number session", "eval", { session: 42, expression: "1" }, /^usage: argument 'session' of 'eval' must be a non-empty string, got number$/],
    ["an empty session", "eval", { session: "", expression: "1" }, /^usage: argument 'session' of 'eval' must be a non-empty string, got ""$/],
    ["an object positional", "eval", { expression: { a: 1 } }, /^usage: argument 'expression' of 'eval' must be a string or a number, got object$/],
    ["an array positional", "goto", { url: ["https://e.com"] }, /^usage: argument 'url' of 'goto' must be a string or a number, got array$/],
    ["a boolean positional", "eval", { expression: true }, /^usage: argument 'expression' of 'eval' must be a string or a number, got boolean$/],
    ["an object string flag", "snapshot", { filename: {} }, /^usage: argument 'filename' of 'snapshot' must be a string or a number, got object$/],
    ["a string boolean flag", "open", { session: "s", persistent: "false" }, /^usage: argument 'persistent' of 'open' must be true or false, got string$/],
    ["a number boolean flag", "open", { session: "s", persistent: 1 }, /^usage: argument 'persistent' of 'open' must be true or false, got number$/],
    ["an unknown key", "eval", { expression: "1", bogus: 1 }, /^usage: unknown argument 'bogus' for 'eval'$/],
    ["an array of arguments", "eval", ["1"], /^usage: the arguments of 'eval' must be an object, got array$/],
    ["a string of arguments", "eval", "1", /^usage: the arguments of 'eval' must be an object, got string$/],
  ];
  for (const [what, tool, args, message] of refused) {
    test(`${what} is an isError usage result, and nothing runs`, async () => {
      const { result, argv } = await call(tool, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(message);
      expect(argv).toBeNull();
    });
  }

  test("a number too large to be finite (1e400 parses to Infinity) is refused", async () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resize","arguments":{"width":1e400,"height":600}}}';
    const { result, argv } = await callLine(line);
    expect(result.content[0].text).toBe("usage: argument 'width' of 'resize' must be a string or a number, got number");
    expect(argv).toBeNull();
  });

  const accepted: Array<[string, string, unknown, string[]]> = [
    ["numbers for string positionals", "resize", { width: 800, height: 600 }, ["--json", "resize", "--", "800", "600"]],
    ["a number for a string flag", "snapshot", { depth: 1 }, ["--json", "snapshot", "--depth=1"]],
    ["true for a boolean flag", "open", { persistent: true }, ["--json", "open", "--persistent"]],
    ["false for a boolean flag, which adds nothing", "open", { persistent: false }, ["--json", "open"]],
    ["null for an optional argument, which is left out", "open", { url: null, session: null }, ["--json", "open"]],
    ["an empty string positional", "select", { ref: "e3", value: "" }, ["--json", "select", "--", "e3", ""]],
    ["no arguments at all", "list", undefined, ["--json", "list"]],
  ];
  for (const [what, tool, args, expected] of accepted) {
    test(`${what} is accepted`, async () => {
      const { result, argv } = await call(tool, args);
      expect(result.isError).toBeFalsy();
      expect(argv).toEqual(expected);
    });
  }
});

// F41: a client that stops reading is gone. The server's next write failed
// with EPIPE, which crashed it (exit 1, a stack trace on stderr), and a call
// queued behind the running one still ran after the client had left. It now
// exits 0 at the first failed write, before a queued call starts.
describe("bowser mcp exits when its client is gone", () => {
  const HELPER = join(import.meta.dir, "helpers", "mcp-fake-daemon.ts");

  test("stdout closed during a call: exit 0, no EPIPE trace, the queued call never runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bowser-mcp-epipe-"));
    const log = join(dir, "eval.log");
    const proc = Bun.spawn([process.execPath, HELPER], {
      env: { ...process.env, HOME: dir, MCP_FAKE_EVAL_LOG: log, MCP_FAKE_EVAL_MS: "500" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const ran = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    try {
      const call = (id: number, expression: string) =>
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "eval", arguments: { session: "gone", expression } } }) + "\n");
      call(1, "first");
      call(2, "queued");
      proc.stdin.flush();
      const deadline = Date.now() + 5000;
      while (ran().length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(ran()).toEqual(["first"]);
      // The client leaves: it closes its end of the server's stdout, then stdin.
      await proc.stdout.cancel();
      proc.stdin.end();
      const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "still running")]);
      expect(code).toBe(0);
      // Give a queued call that was (wrongly) started time to reach the page.
      await Bun.sleep(100);
      expect(ran()).toEqual(["first"]);
      expect(await new Response(proc.stderr).text()).not.toContain("EPIPE");
    } finally {
      proc.kill();
      await proc.exited;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
