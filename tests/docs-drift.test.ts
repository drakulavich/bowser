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

describe("docs list an enum flag's real values", () => {
  // The narrow half of what the README could be checked for. A full comparison
  // against usageOf() is not possible today: the README abbreviates
  // placeholders (`<d>` where the generated usage says `<domain>`). But a flag
  // that declares `values` has one authoritative list, and the README quoting a
  // different one is the exact drift this test file exists to catch — it is how
  // `--same-site` came to advertise an order the parser did not use.
  for (const c of COMMANDS) {
    for (const f of c.flags) {
      if (!f.values) continue;
      test(`${c.name} --${f.name}`, () => {
        // Markdown escapes the pipes inside a table cell.
        const shown = `--${f.name}=${f.values!.join("\\|")}`;
        // Scope the assertion to the command's own row, so a failure prints
        // that line rather than the whole README.
        const row = README.split("\n").find((l) => l.includes(`\`${c.name} `)) ?? "";
        expect(row).toContain(shown);
      });
    }
  }
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
