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

/** A command counts as documented when its name appears in a code span,
 *  optionally prefixed with `bowser ` (SKILL.md's Command Reference table
 *  writes every entry as `` `bowser <name> ...` ``). */
const documented = (text: string, name: string) =>
  new RegExp("`(?:bowser )?" + name.replace(/-/g, "\\-") + "[ `\\[<]").test(text);

/** The names a doc file presents as commands. Only the `` `bowser <name>` ``
 *  form counts: it is unambiguous, so this never fires on an ordinary code
 *  span. A row that continues with a bare `` `uncheck <ref>` `` after its
 *  `bowser`-prefixed head is not covered — renaming such a command leaves
 *  that half of the row stale and green. */
const claimed = (text: string): string[] => {
  const names = new Set<string>();
  for (const m of text.matchAll(/`bowser ([a-z][a-z-]*)/g)) names.add(m[1]!);
  return [...names];
};

describe("docs list every command", () => {
  test("README", () => {
    expect(COMMANDS.filter((c) => !documented(README, c.name)).map((c) => c.name)).toEqual([]);
  });

  test("SKILL.md", () => {
    expect(COMMANDS.filter((c) => !documented(SKILL, c.name)).map((c) => c.name)).toEqual([]);
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
