// `bowser --help`, generated from the registry so a command cannot be
// missing from it. Layout: two-space indent, the usage (name plus its
// positionals and flags), then the summary in a column. A usage longer than
// the column wraps onto its own line with the summary on the next.

import type { Command } from "./registry.ts";

const HEADER = "bowser — drop-in playwright-cli alternative for AI agents";
const GLOBAL = `Global flags:
  -s, --session <name>     session name (default: "default")
      --json               machine-readable output
  -h, --help               show this help`;

const INDENT = 2;
const GUTTER = 2;
/** No summary starts past here, so every one keeps half an 80-column
 *  terminal. The cookie and snapshot usages run 45 to 157 characters; a
 *  column wide enough for them would leave the other 34 commands a gutter
 *  wider than their own usage. */
const MAX_COL = 40;

/** Two spaces past the widest usage that fits, so the column is as narrow as
 *  the commands allow. Usages at or past it wrap. */
function summaryCol(commands: readonly Command[]): number {
  let col = 0;
  for (const c of commands) {
    const end = INDENT + usageOf(c).length + GUTTER;
    if (end <= MAX_COL && end > col) col = end;
  }
  return col || MAX_COL;
}

export function usageOf(c: Command): string {
  const parts = [c.name];
  for (const p of c.positional) parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  for (const f of c.flags) {
    if (f.kind === "boolean") parts.push(`[--${f.name}]`);
    else parts.push(`[--${f.name}=${f.placeholder ?? f.values?.join("|") ?? `<${f.name}>`}]`);
  }
  return parts.join(" ");
}

export function renderHelp(commands: readonly Command[]): string {
  const col = summaryCol(commands);
  const lines = [HEADER, "", "Commands:"];
  for (const c of commands) {
    const usage = " ".repeat(INDENT) + usageOf(c);
    if (usage.length < col) lines.push(usage.padEnd(col) + c.summary);
    else lines.push(usage, " ".repeat(col) + c.summary);
  }
  lines.push("", GLOBAL);
  return lines.join("\n");
}
