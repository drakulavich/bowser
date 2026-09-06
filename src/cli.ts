#!/usr/bin/env bun
import { renderHelp } from "./cli/help.ts";
import { parse } from "./cli/parser.ts";
import { COMMANDS, findCommand, SCHEMAS } from "./cli/registry.ts";
import type { CommandContext } from "./commands/context.ts";

export async function run(argv: string[]): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (!args.command) return renderHelp(COMMANDS);
  const command = findCommand(args.command);
  // parse() already rejects an unknown command; this is the type narrowing.
  if (!command) throw new Error(`unknown command: ${args.command}`);
  const ctx: CommandContext = { session: args.session, json: args.json };
  return command.run(ctx, { positional: args.positional, flags: args.flags });
}

if (import.meta.main) {
  // Hidden entry point used when the compiled binary re-spawns itself as a
  // daemon (import.meta.url is virtual /$bunfs/... in a compiled binary, so
  // the normal `bun daemon/main.ts` path is unavailable). This MUST stay the
  // first branch in import.meta.main; any code above it would also run inside
  // the daemon process.
  if (process.argv[2] === "--daemon") {
    const session = process.argv[3];
    if (!session) {
      console.error("daemon: missing session name");
      process.exit(1);
    }
    const { startDaemon } = await import("./daemon/server.ts");
    // Mirror daemon/main.ts: startDaemon sets up the socket listener and a
    // keepalive interval, then resolves. Do NOT process.exit() here — that
    // would tear the daemon down the instant its socket is ready (the bug that
    // made the compiled binary's "did not start in time"). The keepalive holds
    // the process open; the `else` keeps us out of the command dispatcher.
    await startDaemon(session);
  } else if (process.argv[2] === "mcp") {
    // Long-lived stdio MCP server. Handled here at the entry layer (like
    // --daemon) because it never returns a string — keeping run()'s contract
    // string-returning. It is still listed in SCHEMAS/HELP for discoverability.
    const { runMcpServer } = await import("./mcp.ts");
    // Pass our own `run` so the MCP server never re-imports this module — cli.ts
    // is still mid-evaluation here (top-level await below), and a dynamic
    // import("./cli.ts") would deadlock in the compiled binary.
    await runMcpServer({ run });
  } else {
    try {
      const out = await run(process.argv.slice(2));
      if (out) console.log(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`bowser: ${msg}`);
      const userError = /^(usage:|unknown command|expected a ref|ref '.*' not found|no open page|invalid BOWSER_BACKEND|BOWSER_BACKEND=webkit)/i.test(msg);
      process.exit(userError ? 1 : 2);
    }
  }
}
