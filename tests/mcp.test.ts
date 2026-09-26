// Unit tests for the MCP bridge (src/mcp.ts).
//
// The protocol core (handleMcpRequest) takes an injected `run`, so these tests
// exercise the full request/response surface with NO real stdio or daemon.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTools,
  toArgv,
  handleMcpRequest,
  handleMcpLine,
  type McpDeps,
} from "../src/mcp.ts";
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
          refs: [{ id: "e1", selector: "input", role: "textbox", name: "Email", tag: "input" }] });
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
      const [first, second] = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
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
          refs: [{ id: "e1", selector: "input", role: "textbox", name: "Password", tag: "input" }] });
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
