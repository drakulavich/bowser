#!/usr/bin/env bun
import { renderCommandHelp, renderHelp, usageOf } from "./cli/help.ts";
import { helpRequested, parse } from "./cli/parser.ts";
import { COMMANDS, findCommand, SCHEMAS } from "./cli/registry.ts";
import { failedModalState, type CommandContext } from "./commands/context.ts";
import { UserError } from "./errors.ts";

/** `base` seeds the command context; tests inject `connect` through it. */
export async function run(argv: string[], base: Partial<CommandContext> = {}): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (!args.command) return renderHelp(COMMANDS);
  const command = findCommand(args.command);
  // parse() rejects an unknown command unless --help came first; this is
  // that case, and the type narrowing.
  if (!command) throw new UserError(`unknown command: ${args.command}`);
  // -h/--help anywhere before `--` prints the help and runs nothing:
  // `close --help` once closed the session.
  if (args.help) return renderCommandHelp(command);
  // A word past the declared positionals is refused, not dropped: `eval 1 + 1`
  // once printed 1. Words after `--` count too.
  const declared = command.positional.length;
  if (args.positional.length > declared) {
    throw new UserError(
      `usage: too many arguments for '${command.name}': expected ${declared}, received ${args.positional.length}`,
    );
  }
  // A missing required positional is refused here too (#60): the commands
  // used to see "" for it, so `select e3` selected the empty value. An empty
  // word (`select e3 ""`) is a value, as in playwright-cli. Required
  // positionals come first in every command.
  if (args.positional.length < command.positional.filter((p) => p.required).length) {
    throw new UserError(`usage: bowser ${usageOf(command)}`);
  }
  const ctx: CommandContext = { ...base, session: args.session, json: args.json, command: command.name };
  return command.run(ctx, { positional: args.positional, flags: args.flags });
}

/** What the CLI prints for a failed command, and its exit code: `1` for a
 *  `UserError`, `2` for any other error. The throw site decides, never the
 *  message: a page error that reads `usage: …` is still exit 2. A page
 *  command's dialogs follow the message as `### Modal state`. */
export function reportFailure(err: unknown): { stderr: string; code: 1 | 2 } {
  const msg = err instanceof Error ? err.message : String(err);
  const modal = failedModalState(err);
  return { stderr: `bowser: ${msg}${modal ? `\n${modal}` : ""}`, code: err instanceof UserError ? 1 : 2 };
}

/** `bowser mcp` starts the server only when argv asks for nothing else.
 *  `--help` prints the help, and an extra word falls through to run(), which
 *  refuses it like any command's. */
function startsMcpServer(argv: string[]): boolean {
  if (argv[0] !== "mcp" || helpRequested(SCHEMAS, argv)) return false;
  try {
    return parse(SCHEMAS, argv).positional.length === 0;
  } catch {
    // An unknown flag: the server starts, as it did before this check.
    return true;
  }
}

if (import.meta.main) {
  if (startsMcpServer(process.argv.slice(2))) {
    // Long-lived stdio MCP server. Handled here at the entry layer because it
    // never returns a string — keeping run()'s contract string-returning. It is still listed in SCHEMAS/HELP for discoverability.
    const { runMcpServer } = await import("./mcp.ts");
    // Pass our own `run` so the MCP server never re-imports this module — cli.ts
    // is still mid-evaluation here (top-level await below). A dynamic
    // import("./cli.ts") deadlocked in the old compiled binary; from source it
    // was never measured.
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
