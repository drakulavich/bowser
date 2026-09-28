// The command registry: one Command per command, contributed by the module
// that implements it. Dispatch (cli.ts), --help (cli.ts) and the MCP tool
// list (mcp.ts) all read this, so a command cannot exist in one and not the
// others. SCHEMAS is derived here; the parser still owns argv parsing.
//
// COMMANDS groups by the module that owns each command (navigation,
// snapshot, interaction, dialog, web-storage, scripting, storage-state, then
// mcp), not by today's hand-maintained SCHEMAS.commands order — a module's own
// COMMANDS array can only be spread as one contiguous block, and interaction's
// commands (click..uncheck, resize) are split around snapshot's `screenshot`
// in that order. Every downstream consumer looks commands up by name
// (findCommand, parser.ts's `find`), so the grouping is cosmetic.

import type { Command } from "../commands/context.ts";
import { COMMANDS as DIALOG } from "../commands/dialog.ts";
import { COMMANDS as INTERACTION } from "../commands/interaction.ts";
import { COMMANDS as NAVIGATION } from "../commands/navigation.ts";
import { COMMANDS as SCRIPTING } from "../commands/scripting.ts";
import { COMMANDS as SNAPSHOT } from "../commands/snapshot.ts";
import { COMMANDS as STORAGE_STATE } from "../commands/storage-state.ts";
import { COMMANDS as WEB_STORAGE } from "../commands/web-storage.ts";
import type { Schemas } from "./parser.ts";
import { UserError } from "../errors.ts";

/** `mcp` has no implementation module — it is a long-lived server intercepted
 *  at the import.meta.main entry layer (it never returns a string), so it
 *  never reaches the dispatcher in normal use. This guard only fires if
 *  run(["mcp"]) is called directly, mirroring today's `case "mcp"` in cli.ts. */
const MCP_COMMAND: Command = {
  name: "mcp",
  summary: "Run a Model Context Protocol stdio server exposing commands as tools",
  positional: [],
  flags: [],
  mcp: false,
  run: () => {
    throw new UserError("usage: run 'bowser mcp' as a top-level subcommand");
  },
};

/** Order is the order `--help` prints. */
export const COMMANDS: readonly Command[] = [
  ...NAVIGATION,
  ...SNAPSHOT,
  ...INTERACTION,
  ...DIALOG,
  ...WEB_STORAGE,
  ...SCRIPTING,
  ...STORAGE_STATE,
  MCP_COMMAND,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export const SCHEMAS: Schemas = {
  global: [
    { name: "session", short: "s", kind: "string" },
    { name: "json", kind: "boolean" },
    { name: "help", short: "h", kind: "boolean" },
  ],
  commands: COMMANDS.map((c) => ({ name: c.name, positional: c.positional, flags: c.flags })),
};
