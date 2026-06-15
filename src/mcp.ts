// MCP (Model Context Protocol) stdio bridge.
//
// `bowser mcp` runs a long-lived newline-delimited JSON-RPC server that exposes
// every bowser command as an MCP tool. The bridge is a thin adapter: it reflects
// over SCHEMAS.commands to generate tool definitions, and for each `tools/call`
// it reconstructs a CLI argv and calls the existing `run()` — the single source
// of truth for dispatch, validation, and the --json output contract.
//
// Hand-rolled protocol, zero runtime dependencies (the repo is devDep-only).
//
// STDOUT PURITY: only JSON-RPC messages may be written to stdout. Diagnostics go
// to stderr. We never console.log here, and we call run() (which RETURNS a
// string) rather than letting a command print — that is also why `install`
// (which inherits child stdio) is excluded from the tool set.

import { SCHEMAS } from "./cli/schemas.ts";
import type { CommandSchema } from "./cli/parser.ts";
import pkg from "../package.json";

const VERSION = (pkg as { version: string }).version;

/** Protocol version advertised when the client doesn't request a known one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Commands NOT exposed as tools.
 *  - mcp: must not expose itself (would spawn another server).
 *  - install: shells out with inherited stdio + long download — pollutes stdout
 *    and is a one-time operator action, not a browser-driving command. */
export const MCP_EXCLUDED = new Set<string>(["mcp", "install"]);

/** One-line tool descriptions, mirroring the CLI HELP text. A drift-guard test
 *  asserts every non-excluded command has an entry here. */
export const DESCRIPTIONS: Record<string, string> = {
  open: "Start or attach to a session; navigate if a URL is given",
  goto: "Navigate the current session to a URL",
  close: "Close a session (or all sessions with --all)",
  snapshot: "Capture an aria-tree YAML snapshot of the page (refs for interaction)",
  click: "Click the element with the given ref",
  fill: "Fill the element with the given ref with text",
  type: "Type text into the focused element",
  press: "Press a key (e.g. Enter, Tab)",
  hover: "Hover over the element with the given ref",
  select: "Select an option value in the element with the given ref",
  check: "Check the checkbox/radio with the given ref",
  uncheck: "Uncheck the checkbox with the given ref",
  screenshot: "Save a full-page PNG screenshot",
  resize: "Set the viewport size in pixels",
  "go-back": "Navigate back in history",
  "go-forward": "Navigate forward in history",
  reload: "Reload the current page",
  list: "List active sessions",
  "localstorage-list": "List all localStorage entries",
  "localstorage-get": "Read a localStorage value",
  "localstorage-set": "Write a localStorage entry",
  "localstorage-delete": "Remove a localStorage entry",
  "localstorage-clear": "Clear all localStorage entries",
  "sessionstorage-list": "List all sessionStorage entries",
  "sessionstorage-get": "Read a sessionStorage value",
  "sessionstorage-set": "Write a sessionStorage entry",
  "sessionstorage-delete": "Remove a sessionStorage entry",
  "sessionstorage-clear": "Clear all sessionStorage entries",
  eval: "Evaluate a JS expression in the page and return the result",
  "run-code": "Run multi-statement JS in the page and return the result",
  "cookie-list": "List cookies, HttpOnly included (chrome backend only)",
  "cookie-get": "Print a cookie's value (chrome backend only)",
  "cookie-set": "Set a cookie (chrome backend only)",
  "cookie-delete": "Delete matching cookie(s) (chrome backend only)",
  "cookie-clear": "Wipe all cookies in this session (chrome backend only)",
  "state-save": "Save cookies + localStorage to a Playwright storageState file (chrome backend only)",
  "state-load": "Restore cookies + localStorage from a storageState file (chrome backend only)",
};

export interface McpDeps {
  /** The CLI dispatcher. Injected in tests; defaults to cli.run. */
  run: (argv: string[]) => Promise<string>;
  /** serverInfo.version. */
  version: string;
}

interface JsonSchemaProp {
  type: "string" | "boolean";
  description?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required: string[];
  };
}

/** Reflect over SCHEMAS.commands to generate one MCP tool per non-excluded
 *  command. Positionals → string props (required ones into `required`); flags →
 *  boolean|string props (never required); plus an optional `session` string. */
export function buildTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const cmd of SCHEMAS.commands) {
    if (MCP_EXCLUDED.has(cmd.name)) continue;
    const properties: Record<string, JsonSchemaProp> = {};
    const required: string[] = [];
    for (const p of cmd.positional) {
      properties[p.name] = { type: "string", description: `${p.name} (positional argument)` };
      if (p.required) required.push(p.name);
    }
    for (const f of cmd.flags) {
      properties[f.name] = { type: f.kind === "boolean" ? "boolean" : "string", description: `--${f.name}` };
    }
    properties.session = { type: "string", description: 'bowser session name (default: "default")' };
    tools.push({
      name: cmd.name,
      description: DESCRIPTIONS[cmd.name] ?? `bowser ${cmd.name}`,
      inputSchema: { type: "object", properties, required },
    });
  }
  return tools;
}

/** Reconstruct a CLI argv from structured MCP tool arguments so the call routes
 *  through the existing run() dispatcher. Shape:
 *  [--session <s>] --json <name> <positionals…> <flags…> */
export function toArgv(schema: CommandSchema, args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  const session = args.session;
  if (typeof session === "string" && session.length > 0) argv.push("--session", session);
  argv.push("--json", schema.name);
  for (const p of schema.positional) {
    const v = args[p.name];
    // Stop at the first gap so a missing positional can't shift later ones.
    if (v === undefined || v === null) break;
    argv.push(String(v));
  }
  for (const f of schema.flags) {
    const v = args[f.name];
    if (v === undefined || v === null) continue;
    if (f.kind === "boolean") {
      if (v === true || v === "true") argv.push(`--${f.name}`);
    } else {
      argv.push(`--${f.name}=${String(v)}`);
    }
  }
  return argv;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolResult(id: unknown, text: string, isError?: boolean) {
  const result: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
    content: [{ type: "text", text }],
  };
  if (isError) result.isError = true;
  return jsonRpcResult(id, result);
}

async function handleToolCall(id: unknown, params: unknown, deps: McpDeps) {
  const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const name = p.name;
  const args = p.arguments ?? {};
  const schema = name && !MCP_EXCLUDED.has(name)
    ? SCHEMAS.commands.find((c) => c.name === name)
    : undefined;
  if (!schema) return toolResult(id, `unknown tool: ${name}`, true);
  try {
    const out = await deps.run(toArgv(schema, args));
    return toolResult(id, out || "");
  } catch (e) {
    return toolResult(id, e instanceof Error ? e.message : String(e), true);
  }
}

/** Process one parsed JSON-RPC message. Returns the response object, or null for
 *  notifications (no id) — which get no reply per JSON-RPC. */
export async function handleMcpRequest(req: unknown, deps: McpDeps): Promise<object | null> {
  const r = (req ?? {}) as { id?: unknown; method?: string; params?: unknown };
  const hasId = typeof req === "object" && req !== null && "id" in req && r.id !== null && r.id !== undefined;
  // No id → notification (or unaddressable). Per JSON-RPC, send no response.
  if (!hasId) return null;

  switch (r.method) {
    case "initialize": {
      const requested = (r.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof requested === "string" && requested ? requested : MCP_PROTOCOL_VERSION;
      return jsonRpcResult(r.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bowser", version: deps.version },
      });
    }
    case "tools/list":
      return jsonRpcResult(r.id, { tools: buildTools() });
    case "tools/call":
      return handleToolCall(r.id, r.params, deps);
    case "ping":
      return jsonRpcResult(r.id, {});
    default:
      return jsonRpcError(r.id, -32601, `Method not found: ${r.method}`);
  }
}

/** Parse one stdin line and dispatch. Malformed JSON → -32700. */
export async function handleMcpLine(line: string, deps: McpDeps): Promise<object | null> {
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }
  return handleMcpRequest(req, deps);
}

/** The long-lived stdio loop. Reads newline-delimited JSON-RPC from stdin and
 *  writes responses to stdout. Holds the process open until stdin closes.
 *
 *  `run` MUST be passed in by the caller (cli.ts entry layer hands its own
 *  `run`). Do NOT `import("./cli.ts")` here: cli.ts is mid-evaluation when it
 *  invokes this (blocked on its top-level `await runMcpServer()`), so a dynamic
 *  import of it deadlocks in the compiled binary. */
export async function runMcpServer(deps: { run: McpDeps["run"]; version?: string }): Promise<void> {
  const d: McpDeps = { run: deps.run, version: deps.version ?? VERSION };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const res = await handleMcpLine(line, d);
      if (res !== null) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}
