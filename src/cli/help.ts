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

/** Column the summaries start at. Usages at or past it wrap. */
const SUMMARY_COL = 54;

export function usageOf(c: Command): string {
  const parts = [c.name];
  for (const p of c.positional) parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  for (const f of c.flags) {
    if (f.kind === "boolean") parts.push(`[--${f.name}]`);
    else parts.push(`[--${f.name}=${f.placeholder ?? `<${f.name}>`}]`);
  }
  return parts.join(" ");
}

export function renderHelp(commands: readonly Command[]): string {
  const lines = [HEADER, "", "Commands:"];
  for (const c of commands) {
    const usage = "  " + usageOf(c);
    if (usage.length < SUMMARY_COL) lines.push(usage.padEnd(SUMMARY_COL) + c.summary);
    else lines.push(usage, " ".repeat(SUMMARY_COL) + c.summary);
  }
  lines.push("", GLOBAL);
  return lines.join("\n");
}
