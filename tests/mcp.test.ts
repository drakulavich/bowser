// Unit tests for the MCP bridge (src/mcp.ts).
//
// The protocol core (handleMcpRequest) takes an injected `run`, so these tests
// exercise the full request/response surface with NO real stdio or daemon.

import { describe, expect, test } from "bun:test";

import {
  buildTools,
  toArgv,
  handleMcpRequest,
  handleMcpLine,
  MCP_EXCLUDED,
  DESCRIPTIONS,
  type McpDeps,
} from "../src/mcp.ts";
import { SCHEMAS } from "../src/cli/schemas.ts";

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
    expect(tools.length).toBe(SCHEMAS.commands.length - MCP_EXCLUDED.size);
  });

  test("excludes mcp and install", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).not.toContain("mcp");
    expect(names).not.toContain("install");
    expect(names).toContain("open");
    expect(names).toContain("cookie-set");
  });

  test("cookie-set inputSchema: required positionals, optional session, typed flags", () => {
    const tool = buildTools().find((t) => t.name === "cookie-set")!;
    const s = tool.inputSchema;
    expect(s.type).toBe("object");
    expect(s.required).toContain("name");
    expect(s.required).toContain("value");
    expect(s.required).not.toContain("session");
    expect(s.properties.session).toEqual({ type: "string", description: expect.any(String) });
    expect(s.properties.name.type).toBe("string");
    expect(s.properties["http-only"].type).toBe("boolean");
    expect(s.properties.domain.type).toBe("string");
  });

  test("every tool carries a non-empty description", () => {
    for (const t of buildTools()) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe("toArgv", () => {
  test("reconstructs session, --json, positionals (schema order), typed flags", () => {
    const argv = toArgv(schema("cookie-set"), {
      name: "sid",
      value: "abc",
      "http-only": true,
      domain: "x.com",
      session: "s1",
    });
    expect(argv).toEqual([
      "--session", "s1",
      "--json",
      "cookie-set",
      "sid", "abc",
      "--domain=x.com",
      "--http-only",
    ]);
  });

  test("omits a false boolean flag and an absent session", () => {
    const argv = toArgv(schema("cookie-set"), {
      name: "sid",
      value: "abc",
      "http-only": false,
      secure: true,
    });
    expect(argv).toEqual(["--json", "cookie-set", "sid", "abc", "--secure"]);
  });

  test("no-positional, no-flag command", () => {
    expect(toArgv(schema("list"), {})).toEqual(["--json", "list"]);
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
    expect(res.result.tools.length).toBe(SCHEMAS.commands.length - MCP_EXCLUDED.size);
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
    expect(captured).toEqual(["--json", "goto", "https://e.com"]);
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

  test("unknown tool → tool error result", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nonexistent", arguments: {} } },
      okRun(),
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("nonexistent");
  });

  test("an excluded command is not callable as a tool", async () => {
    const res: any = await handleMcpRequest(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "install", arguments: {} } },
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
  test("every non-excluded command has a DESCRIPTIONS entry", () => {
    for (const c of SCHEMAS.commands) {
      if (MCP_EXCLUDED.has(c.name)) continue;
      expect(DESCRIPTIONS[c.name], `missing description for ${c.name}`).toBeDefined();
    }
  });
});
