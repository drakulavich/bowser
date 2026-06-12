#!/usr/bin/env bun
import { parse } from "./cli/parser.ts";
import { SCHEMAS } from "./cli/schemas.ts";
import {
  cmdInstall, cmdOpen, cmdGoto, cmdClose, cmdSnapshot, cmdClick,
  cmdFill, cmdType, cmdPress, cmdHover, cmdSelect, cmdCheck,
  cmdUncheck, cmdScreenshot, cmdHistory, cmdList,
  cmdLocalStorageList, cmdLocalStorageGet, cmdLocalStorageSet,
  cmdLocalStorageDelete, cmdLocalStorageClear,
  cmdSessionStorageList, cmdSessionStorageGet, cmdSessionStorageSet,
  cmdSessionStorageDelete, cmdSessionStorageClear,
  cmdEval, cmdRunCode,
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
  screenshot [--filename=f]         full-page screenshot (PNG)
  go-back
  go-forward
  reload
  list                               list sessions
  localstorage-list                  list all localStorage entries
  localstorage-get <key>             read a localStorage value
  localstorage-set <key> <value>     write a localStorage entry
  localstorage-delete <key>          remove a localStorage entry
  localstorage-clear                 clear all localStorage entries
  sessionstorage-list                list all sessionStorage entries
  sessionstorage-get <key>           read a sessionStorage value
  sessionstorage-set <key> <value>   write a sessionStorage entry
  sessionstorage-delete <key>        remove a sessionStorage entry
  sessionstorage-clear               clear all sessionStorage entries
  eval <expression>                  evaluate JS expression in the page, print result
  run-code <code>                    run multi-statement JS in the page, print result

Global flags:
  -s, --session <name>     session name (default: "default")
      --json               machine-readable output
  -h, --help               show this help`;

export async function run(argv: string[]): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (args.help && !args.command) return HELP;
  if (!args.command) return HELP;

  const ctx: CommandContext = { session: args.session, json: args.json };
  const [p0, p1] = args.positional;

  switch (args.command) {
    case "install":    return cmdInstall(ctx, { force: Boolean(args.flags.force) });
    case "open":       return cmdOpen(ctx, p0);
    case "goto":       return cmdGoto(ctx, p0 ?? "");
    case "close":      return cmdClose(ctx, { name: p0, all: Boolean(args.flags.all) });
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
      filename: args.flags.filename as string | undefined,
    });
    case "go-back":    return cmdHistory(ctx, "back");
    case "go-forward": return cmdHistory(ctx, "forward");
    case "reload":     return cmdHistory(ctx, "reload");
    case "list":       return cmdList(ctx);
    case "localstorage-list":   return cmdLocalStorageList(ctx);
    case "localstorage-get":    return cmdLocalStorageGet(ctx, p0 ?? "");
    case "localstorage-set":    return cmdLocalStorageSet(ctx, p0 ?? "", p1 ?? "");
    case "localstorage-delete": return cmdLocalStorageDelete(ctx, p0 ?? "");
    case "localstorage-clear":  return cmdLocalStorageClear(ctx);
    case "sessionstorage-list":   return cmdSessionStorageList(ctx);
    case "sessionstorage-get":    return cmdSessionStorageGet(ctx, p0 ?? "");
    case "sessionstorage-set":    return cmdSessionStorageSet(ctx, p0 ?? "", p1 ?? "");
    case "sessionstorage-delete": return cmdSessionStorageDelete(ctx, p0 ?? "");
    case "sessionstorage-clear":  return cmdSessionStorageClear(ctx);
    case "eval":      return cmdEval(ctx, p0 ?? "");
    case "run-code":  return cmdRunCode(ctx, p0 ?? "");
    default:           throw new Error(`unknown command: ${args.command}`);
  }
}

if (import.meta.main) {
  // Hidden entry point used when the compiled binary re-spawns itself as a
  // daemon (import.meta.url is virtual /$bunfs/... in a compiled binary, so
  // the normal `bun daemon-main.ts` path is unavailable). This MUST stay the
  // first branch in import.meta.main; any code above it would also run inside
  // the daemon process.
  if (process.argv[2] === "--daemon") {
    const session = process.argv[3];
    if (!session) {
      console.error("daemon-main: missing session name");
      process.exit(1);
    }
    const { startDaemon } = await import("./daemon.ts");
    // Mirror daemon-main.ts: startDaemon sets up the socket listener and a
    // keepalive interval, then resolves. Do NOT process.exit() here — that
    // would tear the daemon down the instant its socket is ready (the bug that
    // made the compiled binary's "did not start in time"). The keepalive holds
    // the process open; the `else` keeps us out of the command dispatcher.
    await startDaemon(session);
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
