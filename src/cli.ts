#!/usr/bin/env bun
import { renderHelp } from "./cli/help.ts";
import { parse } from "./cli/parser.ts";
import { COMMANDS, findCommand, SCHEMAS } from "./cli/registry.ts";
import { failedModalState, type CommandContext } from "./commands/context.ts";

/** `base` seeds the command context; tests inject `connect` through it. */
export async function run(argv: string[], base: Partial<CommandContext> = {}): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (!args.command) return renderHelp(COMMANDS);
  const command = findCommand(args.command);
  // parse() already rejects an unknown command; this is the type narrowing.
  if (!command) throw new Error(`unknown command: ${args.command}`);
  const ctx: CommandContext = { ...base, session: args.session, json: args.json };
  return command.run(ctx, { positional: args.positional, flags: args.flags });
}

/** What the CLI prints for a failed command, and its exit code: `1` for a
 *  user error, `2` otherwise, read from the message alone. A page command's
 *  dialogs follow the message as `### Modal state`. */
export function reportFailure(err: unknown): { stderr: string; code: 1 | 2 } {
  const msg = err instanceof Error ? err.message : String(err);
  const userError = /^(usage:|unknown command|unknown flag|expected a ref|ref '.*' not found|ref '.*' is not an? |no open page|bowser requires macOS)/i.test(msg);
  const modal = failedModalState(err);
  return { stderr: `bowser: ${msg}${modal ? `\n${modal}` : ""}`, code: userError ? 1 : 2 };
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
    const { DAEMON_PROFILE_ENV } = await import("./daemon/client.ts");
    // Mirror daemon/main.ts: startDaemon sets up the socket listener and a
    // keepalive interval, then resolves. Do NOT process.exit() here — that
    // would tear the daemon down the instant its socket is ready (the bug that
    // made the compiled binary's "did not start in time"). The keepalive holds
    // the process open; the `else` keeps us out of the command dispatcher.
    await startDaemon(session, process.env[DAEMON_PROFILE_ENV] || undefined);
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
      const { stderr, code } = reportFailure(err);
      console.error(stderr);
      process.exit(code);
    }
  }
}
