#!/usr/bin/env bun
import { parse } from "./cli/parser.ts";
import { SCHEMAS } from "./cli/schemas.ts";
import {
  cmdInstall, cmdOpen, cmdGoto, cmdClose, cmdSnapshot, cmdClick,
  cmdFill, cmdType, cmdPress, cmdHover, cmdSelect, cmdCheck,
  cmdUncheck, cmdScreenshot, cmdHistory, cmdList,
  type CommandContext,
} from "./commands.ts";

const HELP = `bowser — drop-in playwright-cli alternative for AI agents

Commands:
  install [--force]                  download a headless Chromium
  open [url]                         start session; navigate if URL given
  goto <url>                         navigate within current session
  close                              end session
  snapshot [--filename=f] [--depth=N] aria-tree YAML of the page
  click <ref>
  fill <ref> <text>
  type <text>
  press <key>
  hover <ref>
  select <ref> <value>
  check <ref>
  uncheck <ref>
  screenshot [ref] [--filename=f]
  go-back
  go-forward
  reload
  list                               list sessions

Global flags:
  -s, --session <name>     session name (default: "default")
      --json               machine-readable output
  -h, --help               show this help`;

export async function run(argv: string[]): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (args.help && !args.command) return HELP;
  if (!args.command) return HELP;

  const ctx: CommandContext = { session: args.session, json: args.json, flags: args.flags };
  const [p0, p1] = args.positional;

  switch (args.command) {
    case "install":    return cmdInstall(ctx, { force: Boolean(args.flags.force) });
    case "open":       return cmdOpen(ctx, p0);
    case "goto":       return cmdGoto(ctx, p0 ?? "");
    case "close":      return cmdClose(ctx);
    case "snapshot":   return cmdSnapshot(ctx, {
      filename: args.flags.filename as string | undefined,
      depth: args.flags.depth as string | undefined,
    });
    case "click":      return cmdClick(ctx, p0 ?? "");
    case "fill":       return cmdFill(ctx, p0 ?? "", p1 ?? "");
    case "type":       return cmdType(ctx, p0 ?? "");
    case "press":      return cmdPress(ctx, p0 ?? "");
    case "hover":      return cmdHover(ctx, p0 ?? "");
    case "select":     return cmdSelect(ctx, p0 ?? "", p1 ?? "");
    case "check":      return cmdCheck(ctx, p0 ?? "");
    case "uncheck":    return cmdUncheck(ctx, p0 ?? "");
    case "screenshot": return cmdScreenshot(ctx, {
      ref: p0,
      filename: args.flags.filename as string | undefined,
    });
    case "go-back":    return cmdHistory(ctx, "back");
    case "go-forward": return cmdHistory(ctx, "forward");
    case "reload":     return cmdHistory(ctx, "reload");
    case "list":       return cmdList(ctx);
    default:           throw new Error(`unknown command: ${args.command}`);
  }
}

if (import.meta.main) {
  try {
    const out = await run(process.argv.slice(2));
    if (out) console.log(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`bowser: ${msg}`);
    const userError = /^(usage:|unknown command|expected a ref|ref '.*' not found|no open page)/i.test(msg);
    process.exit(userError ? 1 : 2);
  }
}
