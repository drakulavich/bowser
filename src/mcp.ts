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

import { accessSync, constants, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, findCommand, SCHEMAS } from "./cli/registry.ts";
import { parse } from "./cli/parser.ts";
import { failedModalState } from "./commands/context.ts";
import type { CommandSchema } from "./cli/parser.ts";
import pkg from "../package.json";
import { UserError } from "./errors.ts";

const VERSION = (pkg as { version: string }).version;

/** The protocol versions this server speaks, newest first (F39). `initialize`
 *  echoes the client's version when it is listed, and answers the first entry
 *  otherwise. 2025-03-26 is left out: it requires JSON-RPC batches, which
 *  this server refuses (F40). The stateless 2026-07-28 revision is not
 *  implemented: its client probes with `server/discover`, gets -32601 like
 *  any unknown method, and falls back to `initialize`. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"] as const;

export interface McpDeps {
  /** The CLI dispatcher. Injected in tests; defaults to cli.run. */
  run: (argv: string[], base?: { notices?: string[]; acks?: (() => void)[] }) => Promise<string>;
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

/** How a refused argument is named in a usage error. */
function kindOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === "") return '""';
  return typeof v;
}

/** A string, or a finite number taken as its string: the schema says string
 *  for `width` or `depth`, and models send numbers there (F42). */
function stringArg(schema: CommandSchema, key: string, v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new UserError(`usage: argument '${key}' of '${schema.name}' must be a string or a number, got ${kindOf(v)}`);
}

/** Reconstruct a CLI argv from structured MCP tool arguments so the call routes
 *  through the existing run() dispatcher. Shape:
 *  [--session <s>] --json <name> <flags…> [-- <positionals…>]
 *  The `--` keeps a value such as "--json" or "--stdin" a positional: it is
 *  data from the client, never a flag.
 *
 *  Each value must have its inputSchema type, or this throws a `usage:`
 *  UserError (F42): nothing is converted or dropped. `null` is the same as
 *  leaving an argument out. Unknown keys are prepareToolCall's check. */
export function toArgv(schema: CommandSchema, args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  const session = args.session;
  if (session !== undefined && session !== null) {
    if (typeof session !== "string" || session === "") {
      throw new UserError(`usage: argument 'session' of '${schema.name}' must be a non-empty string, got ${kindOf(session)}`);
    }
    argv.push("--session", session);
  }
  argv.push("--json", schema.name);
  const positionals: string[] = [];
  for (const p of schema.positional) {
    const v = args[p.name];
    // Stop at the first gap so a missing positional can't shift later ones.
    if (v === undefined || v === null) break;
    positionals.push(stringArg(schema, p.name, v));
  }
  for (const f of schema.flags) {
    const v = args[f.name];
    if (v === undefined || v === null) continue;
    if (f.mcp === false) throw new UserError(`usage: --${f.name} is not available over MCP`);
    if (f.kind === "boolean") {
      if (typeof v !== "boolean") {
        throw new UserError(`usage: argument '${f.name}' of '${schema.name}' must be true or false, got ${kindOf(v)}`);
      }
      if (v) argv.push(`--${f.name}`);
    } else {
      argv.push(`--${f.name}=${stringArg(schema, f.name, v)}`);
    }
  }
  if (positionals.length > 0) argv.push("--", ...positionals);
  return argv;
}

/** The tool's arguments as an object, refusing a key the tool does not have,
 *  as the CLI refuses an extra word (F4, F42). A flag MCP does not offer
 *  (`stdin`) passes here, for toArgv's clearer message. */
function toolArguments(schema: CommandSchema, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new UserError(`usage: the arguments of '${schema.name}' must be an object, got ${kindOf(raw)}`);
  }
  const known = new Set(["session", ...schema.positional.map((p) => p.name), ...schema.flags.map((f) => f.name)]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new UserError(`usage: unknown argument '${key}' for '${schema.name}'`);
  }
  return raw as Record<string, unknown>;
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
 *  anything (an unknown tool's -32602, an argument the tool refuses), otherwise the argv to
 *  run and the session it runs in. */
type PreparedCall = { reply: object } | { argv: string[]; session: string | null };

function prepareToolCall(id: unknown, params: unknown): PreparedCall {
  const p = (params ?? {}) as { name?: string; arguments?: unknown };
  const name = p.name;
  const cmd = name ? findCommand(name) : undefined;
  const schema = cmd && cmd.mcp !== false ? cmd : undefined;
  if (!schema) return { reply: jsonRpcError(id, -32602, `Unknown tool: ${name}`) };
  let argv: string[];
  try {
    argv = toArgv(schema, toolArguments(schema, p.arguments));
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

/** The response, and what to call once it is written: `acks` mark its notices delivered. */
async function runToolCall(id: unknown, argv: string[], deps: McpDeps): Promise<{ res: object; acks: (() => void)[] }> {
  const notices: string[] = [];
  const acks: (() => void)[] = [];
  const first = (text: string) => [...notices, text].filter(Boolean).join("\n");
  try {
    const out = await deps.run(argv, { notices, acks });
    return { res: toolResult(id, first(out || "")), acks };
  } catch (e) {
    // A failed page command still reports the dialogs it answered.
    const modal = failedModalState(e);
    const msg = e instanceof Error ? e.message : String(e);
    return { res: toolResult(id, first(modal ? `${msg}\n${modal}` : msg), true), acks };
  }
}

/** Process one parsed JSON-RPC message. Returns the response object, or null for
 *  notifications (no id) and the client's responses, which get no reply per JSON-RPC. */
export async function handleMcpRequest(req: unknown, deps: McpDeps): Promise<object | null> {
  // F40: a batch (MCP 2025-06-18 has none) or a non-object is not a Request
  // object; JSON-RPC answers it with -32600 and id null, once for a whole
  // batch. Taking it for a notification left a client waiting forever.
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  const r = req as { id?: unknown; method?: string; params?: unknown };
  const hasId = r.id !== null && r.id !== undefined;
  // No id → notification (or unaddressable). Per JSON-RPC, send no response.
  if (!hasId) return null;
  // A client's response: this server sends no requests, and JSON-RPC answers no response.
  if (!("method" in r) && ("result" in r || "error" in r)) return null;
  if (typeof r.method !== "string") return jsonRpcError(r.id, -32600, "Invalid Request");

  switch (r.method) {
    case "initialize": {
      const requested = (r.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(r.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bowser", version: deps.version },
      });
    }
    case "tools/list":
      return jsonRpcResult(r.id, { tools: buildTools() });
    case "ping":
      return jsonRpcResult(r.id, {});
    default:
      return jsonRpcError(r.id, -32601, `Method not found: ${r.method}`);
  }
}

export interface McpServer {
  /** Take one stdin line. Never waits on a tool call: everything but
   *  tools/call is answered at once, and a tools/call is queued behind its
   *  session's earlier calls. */
  accept(line: string): void;
  /** Resolves once every accepted line has been answered and written. */
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
 *  waits for it to finish, or for its deadline: the budget plus 2 s (ET-59).
 *
 *  STDOUT: each response goes out as one `write(JSON + "\n")` call. A stream
 *  keeps the chunks of separate write() calls whole and in call order, so
 *  concurrent responses never interleave within a line. */
export function createMcpServer(deps: McpDeps, write: (line: string) => void | Promise<void>): McpServer {
  const chains = new Map<string, Promise<void>>();
  const inFlight = new Map<unknown, { cancelled: boolean }>();
  const running = new Set<Promise<unknown>>();

  const send = async (res: object): Promise<boolean> => {
    try {
      await write(JSON.stringify(res) + "\n");
      return true;
    } catch (e) {
      console.error(`bowser mcp: could not write a response: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  function track(p: Promise<unknown>): void {
    running.add(p);
    void p.finally(() => running.delete(p));
  }

  function schedule(id: unknown, params: unknown): void {
    const prepared = prepareToolCall(id, params);
    if ("reply" in prepared) {
      track(send(prepared.reply));
      return;
    }
    const { argv, session } = prepared;
    const token = { cancelled: false };
    inFlight.set(id, token);
    const prev = (session !== null && chains.get(session)) || Promise.resolve();
    const tail: Promise<void> = prev
      .then(async () => {
        if (token.cancelled) return;
        const { res, acks } = await runToolCall(id, argv, deps);
        // Keep this session's chain behind stdout completion. If the peer
        // closed its pipe, the write callback reports EPIPE before a queued
        // command can start and cause another side effect.
        if (!token.cancelled && (await send(res))) for (const ack of acks) ack();
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
      {
        track(send(jsonRpcError(null, -32700, "Parse error")));
        return;
      }
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
    track(
      handleMcpRequest(req, deps).then(async (res) => {
        if (res !== null) await send(res);
      }),
    );
  }

  async function idle(): Promise<void> {
    while (running.size > 0) await Promise.all(running);
  }

  return { accept, idle };
}

/** Make the cwd a directory the server can write to (F37). Tool calls resolve
 *  relative paths against it, and an MCP client often starts the server from
 *  `/` (read-only on macOS), where every file output failed with EROFS. A
 *  writable cwd is kept; otherwise it becomes `<os.tmpdir()>/bowser-mcp`, as
 *  Playwright MCP does with its output directory. */
function useWritableCwd(): void {
  try {
    const cwd = process.cwd();
    if (cwd !== "/") {
      accessSync(cwd, constants.W_OK);
      return;
    }
  } catch {
    // Not writable, or gone: fall through.
  }
  const dir = join(tmpdir(), "bowser-mcp");
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
}

/** The long-lived stdio loop. Reads newline-delimited JSON-RPC from stdin and
 *  writes responses to stdout. Holds the process open until stdin closes and
 *  every accepted call has finished.
 *
 *  `run` MUST be passed in by the caller (cli.ts entry layer hands its own
 *  `run`). Do NOT `import("./cli.ts")` here: cli.ts is mid-evaluation when it
 *  invokes this (blocked on its top-level `await runMcpServer()`); a dynamic
 *  import of it deadlocked in the old compiled binary, and whether it does
 *  from source was never measured. */
export async function runMcpServer(deps: { run: McpDeps["run"]; version?: string }): Promise<void> {
  useWritableCwd();
  const d: McpDeps = { run: deps.run, version: deps.version ?? VERSION };
  // F41: a failed stdout write means the client has stopped reading, so no
  // answer can reach it. Exit 0 at once: an EPIPE left unhandled crashed the
  // server with a stack trace, and a call queued behind the running one still
  // ran for no one. A daemon op already running finishes in its daemon, as a
  // cancelled call's does. Bun reports the EPIPE as an 'error' event on
  // stdout; a synchronous throw is handled the same way.
  const clientGone = (e: unknown): never => {
    if ((e as { code?: unknown } | null)?.code === "EPIPE") process.exit(0);
    console.error(`bowser mcp: stdout failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  };
  process.stdout.on("error", clientGone);
  const write = (line: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      try {
        process.stdout.write(line, (e) => {
          if ((e as { code?: unknown } | null)?.code === "EPIPE") clientGone(e);
          if (e) reject(e);
          else resolve();
        });
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "EPIPE") clientGone(e);
        reject(e);
      }
    });
  };
  const server = createMcpServer(d, write);
  const code = await serveLines(lines(Bun.stdin.stream()), server, write, {
    version: d.version,
    installed: installedVersion,
    child: [process.execPath, Bun.fileURLToPath(new URL("./cli.ts", import.meta.url)), "mcp"],
  });
  if (code !== 0) process.exit(code);
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
}

async function installedVersion(): Promise<string | undefined> {
  try {
    return (await Bun.file(new URL("../package.json", import.meta.url)).json()).version;
  } catch {
    return undefined;
  }
}

export interface HandoverOptions {
  version: string;
  installed: () => Promise<string | undefined>;
  child: string[];
}

export async function serveLines(
  input: AsyncIterable<string>,
  server: McpServer,
  write: (line: string) => void | Promise<void>,
  opts: HandoverOptions,
): Promise<number> {
  let init: { id?: unknown } | undefined;
  let handover: Handover | undefined;
  for await (const line of input) {
    let req: { id?: unknown; method?: unknown } | undefined;
    try {
      req = JSON.parse(line);
    } catch {}
    if (handover) {
      // A call it cancels may still be running here.
      if (req?.method === "notifications/cancelled") server.accept(line);
      handover.send(line);
      continue;
    }
    if (req?.method === "initialize") init = req;
    if (req?.method === "tools/call") {
      const installed = await opts.installed();
      if (installed !== undefined && installed !== opts.version) {
        handover = startHandover(server, write, opts.child, init, installed);
        handover.send(line);
        continue;
      }
    }
    server.accept(line);
  }
  if (!handover) {
    await server.idle();
    return 0;
  }
  return handover.end();
}

interface Handover {
  send(line: string): void;
  end(): Promise<number>;
}

const HANDOVER_ID = "bowser-handover";
const HANDOVER_MS = 10_000;

function startHandover(
  server: McpServer,
  write: (line: string) => void | Promise<void>,
  command: string[],
  init: { id?: unknown } | undefined,
  installed: string,
): Handover {
  let child: Bun.Subprocess<ReadableStream, "pipe", "inherit"> | undefined;
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const toChild = (line: string) => input.enqueue(encoder.encode(line + "\n"));
  let failed: string | undefined;
  let forwarded: Promise<void> = Promise.resolve();
  let exited: Promise<number> = Promise.resolve(0);
  // Sent to the child and not yet answered: answered here if it exits first.
  const outstanding = new Map<string, string>();
  const idOf = (line: string): string | undefined => {
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      return id === undefined || id === null ? undefined : JSON.stringify(id);
    } catch {
      return undefined;
    }
  };

  const refuse = (line: string): Promise<void> | undefined => {
    let req: { id?: unknown; method?: unknown } | undefined;
    try {
      req = JSON.parse(line);
    } catch {}
    if (!req || req.id === undefined || req.id === null) return;
    const text = `bowser mcp could not hand over to the installed bowser ${installed}: ${failed}; restart the MCP server`;
    const res = req.method === "tools/call" ? toolResult(req.id, text, true) : jsonRpcError(req.id, -32603, text);
    return Promise.resolve(write(JSON.stringify(res) + "\n"));
  };

  const ready = (async () => {
    // The old server writes nothing after this: the child is the only writer.
    await server.idle();
    const stdin = new ReadableStream<Uint8Array>({
      start: (c) => {
        input = c;
      },
    });
    child = Bun.spawn(command, { stdin, stdout: "pipe", stderr: "inherit", env: process.env, cwd: process.cwd() });
    const out = lines(child.stdout)[Symbol.asyncIterator]();
    if (init) {
      toChild(JSON.stringify({ ...init, id: HANDOVER_ID }));
      toChild(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      const answered = (async () => {
        for (let r = await out.next(); !r.done; r = await out.next()) {
          if ((JSON.parse(r.value) as { id?: unknown }).id === HANDOVER_ID) return true;
        }
        return false;
      })();
      const timeout = Bun.sleep(HANDOVER_MS).then(() => "timeout" as const);
      const got = await Promise.race([answered, timeout]);
      if (got !== true) throw new Error(got === "timeout" ? `it did not answer initialize in ${HANDOVER_MS / 1000} s` : "it exited");
    }
    forwarded = (async () => {
      for (let r = await out.next(); !r.done; r = await out.next()) {
        const id = idOf(r.value);
        if (id !== undefined) outstanding.delete(id);
        await write(r.value + "\n");
      }
    })();
    exited = child.exited.then(async (code) => {
      await forwarded;
      failed = `it exited (code ${code})`;
      await Promise.all([...outstanding.values()].map(refuse));
      outstanding.clear();
      return code;
    });
  })().catch((e: unknown) => {
    failed = e instanceof Error ? e.message : String(e);
    child?.kill();
  });

  let order: Promise<void> = ready;
  return {
    send(line) {
      order = order.then(async () => {
        if (failed !== undefined) return refuse(line);
        const id = idOf(line);
        if (id !== undefined) outstanding.set(id, line);
        toChild(line);
      });
    },
    async end() {
      await order;
      if (!child) return 0;
      // Throws once the child has exited: Bun has cancelled its stdin.
      try {
        input.close();
      } catch {}
      return exited;
    },
  };
}
