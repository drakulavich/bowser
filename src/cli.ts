#!/usr/bin/env bun
// Bowser — Bun-powered browser automation CLI for AI agents.
//
// Usage:
//   bowser open <url>            navigate and save state
//   bowser snap [-i]             snapshot interactive refs
//   bowser click @e3             click a ref
//   bowser fill @e5 "text"       fill a ref
//   bowser close                 clear session state
//   bowser session [list|show]   inspect sessions
//
// Global flags:
//   --session <name>   session name (default: "default")
//   --json             machine-readable output
//   -h, --help         show help

import {
  cmdClick,
  cmdClose,
  cmdFill,
  cmdOpen,
  cmdSession,
  cmdSnap,
  type CommandContext,
} from "./commands.ts";

const HELP = `bowser — Bun-powered browser CLI for agents

Commands:
  open <url>            navigate and save state
  snap [-i]             capture a snapshot of interactive refs (@e1, @e2 ...)
  click <@ref>          click an element by ref
  fill <@ref> <text>    fill a form field by ref
  close                 clear the current session state
  session [list|show]   inspect sessions

Global flags:
  --session <name>   session name (default: "default")
  --json             JSON output
  -h, --help         show this help`;

interface ParsedArgs {
  session: string;
  json: boolean;
  help: boolean;
  interactive: boolean;
  command: string | undefined;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    session: "default",
    json: false,
    help: false,
    interactive: false,
    command: undefined,
    positional: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case "--session":
        out.session = argv[++i] ?? "default";
        break;
      case "--json":
        out.json = true;
        break;
      case "-i":
      case "--interactive":
        out.interactive = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (!out.command) out.command = a;
        else out.positional.push(a);
    }
    i++;
  }
  return out;
}

export async function run(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  if (args.help || !args.command) return HELP;

  const ctx: CommandContext = { session: args.session, json: args.json };

  switch (args.command) {
    case "open":
      return cmdOpen(ctx, args.positional[0] ?? "");
    case "snap":
    case "snapshot":
      return cmdSnap(ctx, { interactive: args.interactive });
    case "click":
      return cmdClick(ctx, args.positional[0] ?? "");
    case "fill":
      return cmdFill(ctx, args.positional[0] ?? "", args.positional[1] ?? "");
    case "close":
      return cmdClose(ctx);
    case "session": {
      const sub = (args.positional[0] ?? "show") as "list" | "show";
      return cmdSession(ctx, sub);
    }
    default:
      throw new Error(`unknown command: ${args.command}\n\n${HELP}`);
  }
}

// Only run main when executed directly (not when imported by tests).
if (import.meta.main) {
  try {
    const out = await run(process.argv.slice(2));
    if (out) console.log(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bowser: ${msg}`);
    process.exit(1);
  }
}
