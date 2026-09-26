// MCP (Model Context Protocol) stdio bridge.
//
// `bowser mcp` runs a long-lived newline-delimited JSON-RPC server that exposes
// every bowser command as an MCP tool. The bridge is a thin adapter: it reflects
// over the command registry to generate tool definitions, and for each
// `tools/call` it reconstructs a CLI argv and calls the existing `run()` — the
// single source of truth for dispatch, validation, and the --json output
// contract.
//
// Hand-rolled protocol, zero runtime dependencies (the repo is devDep-only).
//
// STDOUT PURITY: only JSON-RPC messages may be written to stdout. Diagnostics go
// to stderr. We never console.log here, and we call run() (which RETURNS a
// string) rather than letting a command print.

import { COMMANDS, findCommand, SCHEMAS } from "./cli/registry.ts";
import { parse } from "./cli/parser.ts";
import { failedModalState } from "./commands/context.ts";
import type { CommandSchema } from "./cli/parser.ts";
import pkg from "../package.json";

const VERSION = (pkg as { version: string }).version;

/** Protocol version advertised when the client doesn't request a known one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

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

/** Reflect over COMMANDS to generate one MCP tool per command not opted out
 *  via `mcp: false`. Positionals → string props (required ones into
 *  `required`); flags → boolean|string props (never required); plus an
 *  optional `session` string. A command's `summary` is its tool description. */
export function buildTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.mcp === false) continue;
    const properties: Record<string, JsonSchemaProp> = {};
    const required: string[] = [];
    for (const p of cmd.positional) {
      properties[p.name] = { type: "string", description: `${p.name} (positional argument)` };
      if (p.required || p.mcpRequired) required.push(p.name);
    }
    for (const f of cmd.flags) {
      if (f.mcp === false) continue;
      properties[f.name] = {
        type: f.kind === "boolean" ? "boolean" : "string",
        description: `--${f.name}`,
      };
    }
    properties.session = { type: "string", description: 'bowser session name (default: "default")' };
    tools.push({
      name: cmd.name,
      description: cmd.mcpSummary ?? cmd.summary,
      inputSchema: { type: "object", properties, required },
    });
  }
  return tools;
}

/** Reconstruct a CLI argv from structured MCP tool arguments so the call routes
 *  through the existing run() dispatcher. Shape:
 *  [--session <s>] --json <name> <flags…> [-- <positionals…>]
 *  The `--` keeps a value such as "--json" or "--stdin" a positional: it is
 *  data from the client, never a flag. */
export function toArgv(schema: CommandSchema, args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  const session = args.session;
  if (typeof session === "string" && session.length > 0) argv.push("--session", session);
  argv.push("--json", schema.name);
  const positionals: string[] = [];
  for (const p of schema.positional) {
    const v = args[p.name];
    // Stop at the first gap so a missing positional can't shift later ones.
    if (v === undefined || v === null) break;
    positionals.push(String(v));
  }
  for (const f of schema.flags) {
    const v = args[f.name];
    if (v === undefined || v === null) continue;
    if (f.mcp === false) throw new Error(`usage: --${f.name} is not available over MCP`);
    if (f.kind === "boolean") {
      if (v === true || v === "true") argv.push(`--${f.name}`);
    } else {
      argv.push(`--${f.name}=${String(v)}`);
    }
  }
  if (positionals.length > 0) argv.push("--", ...positionals);
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

/** A tools/call split in two: `reply` when it is answered without running
 *  anything (unknown tool, a flag MCP does not offer), otherwise the argv to
 *  run and the session it runs in. */
type PreparedCall =
  | { reply: object }
  | { argv: string[]; session: string | null };

function prepareToolCall(id: unknown, params: unknown): PreparedCall {
  const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const name = p.name;
  const cmd = name ? findCommand(name) : undefined;
  const schema = cmd && cmd.mcp !== false ? cmd : undefined;
  if (!schema) return { reply: toolResult(id, `unknown tool: ${name}`, true) };
  let argv: string[];
  try {
    argv = toArgv(schema, p.arguments ?? {});
  } catch (e) {
    return { reply: toolResult(id, e instanceof Error ? e.message : String(e), true) };
  }
  // The session is whatever run() will parse out of this same argv, default
  // included. An argv the parser rejects gets null: run() throws the same
  // error before it reaches any daemon, so it needs no place in a queue.
  let session: string | null;
  try {
    session = parse(SCHEMAS, argv).session;
  } catch {
    session = null;
  }
  return { argv, session };
}

async function runToolCall(id: unknown, argv: string[], deps: McpDeps): Promise<object> {
  try {
    const out = await deps.run(argv);
    return toolResult(id, out || "");
  } catch (e) {
    // A failed page command still reports the dialogs it answered.
    const modal = failedModalState(e);
    const msg = e instanceof Error ? e.message : String(e);
    return toolResult(id, modal ? `${msg}\n${modal}` : msg, true);
  }
}

async function handleToolCall(id: unknown, params: unknown, deps: McpDeps) {
  const prepared = prepareToolCall(id, params);
  if ("reply" in prepared) return prepared.reply;
  return runToolCall(id, prepared.argv, deps);
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

export interface McpServer {
  /** Take one stdin line. Never waits on a tool call: everything but
   *  tools/call is answered at once, and a tools/call is queued behind its
   *  session's earlier calls. */
  accept(line: string): void;
  /** Resolves once every accepted tool call has finished. */
  idle(): Promise<void>;
}

/** The server behind `bowser mcp`, minus stdin/stdout.
 *
 *  CONCURRENCY: tools/call requests for different sessions run at the same
 *  time; calls for one session run one after another, in arrival order, on a
 *  per-session promise chain (the daemon would serialize them anyway, and
 *  queuing here keeps a later call from overtaking an earlier one). Responses
 *  may therefore arrive out of order, which JSON-RPC allows.
 *
 *  CANCELLATION: `notifications/cancelled` for a call still queued means it
 *  never runs; for a running call it means its result is dropped. Either way
 *  the call gets no response, per the MCP spec. A daemon op that has started
 *  is NOT undone: `run()` has no way to stop it, and the session's next call
 *  still waits for it to finish.
 *
 *  STDOUT: each response goes out as one `write(JSON + "\n")` call. A stream
 *  keeps the chunks of separate write() calls whole and in call order, so
 *  concurrent responses never interleave within a line. */
export function createMcpServer(deps: McpDeps, write: (line: string) => void): McpServer {
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Map<unknown, { cancelled: boolean }>();
  const running = new Set<Promise<void>>();

  const send = (res: object) => {
    try {
      write(JSON.stringify(res) + "\n");
    } catch (e) {
      console.error(`bowser mcp: could not write a response: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  function schedule(id: unknown, params: unknown): void {
    const prepared = prepareToolCall(id, params);
    if ("reply" in prepared) return send(prepared.reply);
    const { argv, session } = prepared;
    const token = { cancelled: false };
    inFlight.set(id, token);
    const prev = (session !== null && chains.get(session)) || Promise.resolve();
    const tail: Promise<void> = prev
      .then(async () => {
        if (token.cancelled) return;
        const res = await runToolCall(id, argv, deps);
        if (!token.cancelled) send(res);
      })
      .finally(() => {
        if (inFlight.get(id) === token) inFlight.delete(id);
        if (session !== null && chains.get(session) === tail) chains.delete(session);
        running.delete(tail);
      });
    if (session !== null) chains.set(session, tail);
    running.add(tail);
  }

  function accept(line: string): void {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return send(jsonRpcError(null, -32700, "Parse error"));
    }
    const r = (req ?? {}) as { id?: unknown; method?: string; params?: unknown };
    const hasId = typeof req === "object" && req !== null && "id" in req && r.id !== null && r.id !== undefined;
    if (hasId && r.method === "tools/call") return schedule(r.id, r.params);
    if (!hasId && r.method === "notifications/cancelled") {
      const requestId = (r.params as { requestId?: unknown } | undefined)?.requestId;
      const token = inFlight.get(requestId);
      if (token) token.cancelled = true;
      return;
    }
    // Everything else never touches a daemon: answer it now.
    void handleMcpRequest(req, deps).then((res) => {
      if (res !== null) send(res);
    });
  }

  async function idle(): Promise<void> {
    while (running.size > 0) await Promise.all(running);
  }

  return { accept, idle };
}

/** The long-lived stdio loop. Reads newline-delimited JSON-RPC from stdin and
 *  writes responses to stdout. Holds the process open until stdin closes and
 *  every accepted call has finished.
 *
 *  `run` MUST be passed in by the caller (cli.ts entry layer hands its own
 *  `run`). Do NOT `import("./cli.ts")` here: cli.ts is mid-evaluation when it
 *  invokes this (blocked on its top-level `await runMcpServer()`), so a dynamic
 *  import of it deadlocks in the compiled binary. */
export async function runMcpServer(deps: { run: McpDeps["run"]; version?: string }): Promise<void> {
  const d: McpDeps = { run: deps.run, version: deps.version ?? VERSION };
  const server = createMcpServer(d, (line) => {
    process.stdout.write(line);
  });
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) server.accept(line);
    }
  }
  await server.idle();
}
