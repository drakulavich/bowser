// The registry is the source of truth for what commands exist; README and
// SKILL.md are hand-written. Both directions drift, so both are checked: a
// command added without a doc row, and a doc row left behind by a command
// that was renamed or removed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/cli/registry.ts";

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SKILL = readFileSync(join(ROOT, "skills/bowser/SKILL.md"), "utf8");

/** Only the reference tables count as documenting a command. Searching the
 *  whole file would let an incidental example stand in for a deleted row:
 *  drop README's `install` row and `bowser install` still appears in the
 *  install instructions. Every command has a table row in both files today,
 *  so this costs nothing and means what it says. */
const table = (text: string): string =>
  text.split("\n").filter((l) => l.startsWith("|")).join("\n");

/** A command counts as documented when its name appears in a code span,
 *  optionally prefixed with `bowser ` (SKILL.md's Command Reference table
 *  writes every entry as `` `bowser <name> ...` ``). */
const documented = (text: string, name: string) =>
  new RegExp("`(?:bowser )?" + name.replace(/-/g, "\\-") + "[ `\\[<]").test(text);

/** The names a doc file presents as commands. Only the `` `bowser <name>` ``
 *  form counts: it is unambiguous, so this never fires on an ordinary code
 *  span. A row that continues with a bare `` `uncheck <ref>` `` after its
 *  `bowser`-prefixed head is not covered — renaming such a command leaves
 *  that half of the row stale and green. Unlike the check above this reads
 *  the whole file, not just the tables: a stale example is drift too. */
const claimed = (text: string): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/`bowser ([a-z][a-z-]*)/g)) names.add(m[1]!);
  return [...names];
};

describe("docs list every command", () => {
  test("README", () => {
    const rows = table(README);
    expect(COMMANDS.filter((c) => !documented(rows, c.name)).map((c) => c.name)).toEqual([]);
  });

  test("SKILL.md", () => {
    const rows = table(SKILL);
    expect(COMMANDS.filter((c) => !documented(rows, c.name)).map((c) => c.name)).toEqual([]);
  });
});

describe("docs claim no command that is gone", () => {
  const names = new Set(COMMANDS.map((c) => c.name));

  test("README", () => {
    expect(claimed(README).filter((n) => !names.has(n))).toEqual([]);
  });

  test("SKILL.md", () => {
    expect(claimed(SKILL).filter((n) => !names.has(n))).toEqual([]);
  });
});
