// The registry is the source of truth for what commands exist; README and
// SKILL.md are hand-written. Both directions drift, so both are checked: a
// command added without a doc row, and a doc row left behind by a command
// that was renamed or removed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/cli/registry.ts";
import pkg from "../package.json";

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SKILL = readFileSync(join(ROOT, "skills/bowser/SKILL.md"), "utf8");

/** The command names in a file's command-reference table: the section under
 *  its `## Command reference` heading (either case), up to the next `## `.
 *  Only the table's first column counts, and each code span in it names one
 *  command by its first word after an optional `bowser `, so
 *  `` `bowser check <ref>` / `uncheck <ref>` `` yields check and uncheck.
 *  Scoped to that table on purpose: searching the whole file would let an
 *  incidental example stand in for a deleted row, and a whole-file match on
 *  bare names would fire on ordinary code spans. */
const tableCommands = (text: string): Set<string> => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^## Command reference\s*$/i.test(l));
  if (start < 0) throw new Error("no '## Command reference' section");
  const names = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("| `")) continue; // header, separator, prose
    const cell = line.slice(2).split(/(?<!\\)\|/)[0]!;
    for (const m of cell.matchAll(/`(?:bowser )?([a-z][a-z-]*)/g)) names.add(m[1]!);
  }
  return names;
};

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

const REGISTERED = new Set(COMMANDS.map((c) => c.name));

describe("the command-reference table matches the registry", () => {
  for (const [file, text] of [["README", README], ["SKILL.md", SKILL]] as const) {
    test(`${file}: every registered command has a row`, () => {
      const rows = tableCommands(text);
      expect([...REGISTERED].filter((n) => !rows.has(n))).toEqual([]);
    });

    test(`${file}: every row names a registered command`, () => {
      expect([...tableCommands(text)].filter((n) => !REGISTERED.has(n))).toEqual([]);
    });
  }
});

describe("docs claim no command that is gone", () => {
  test("README", () => {
    expect(claimed(README).filter((n) => !REGISTERED.has(n))).toEqual([]);
  });

  test("SKILL.md", () => {
    expect(claimed(SKILL).filter((n) => !REGISTERED.has(n))).toEqual([]);
  });
});

// Spec F17: a screenshot is the viewport (Bun.WebView takes no full-page
// option), and the help, the MCP tool and the docs must not promise more.
describe("screenshot is documented as the viewport", () => {
  test("its summary, and so --help and the MCP description", () => {
    expect(COMMANDS.find((c) => c.name === "screenshot")!.summary).toBe("Save a PNG screenshot of the viewport");
  });
  test("README and SKILL.md say viewport in its row, and drop the old full-page claims", () => {
    for (const doc of [README, SKILL]) {
      expect(doc.split("\n").find((l) => /^\| `(bowser )?screenshot /.test(l))).toContain("viewport");
      expect(doc).not.toMatch(/Full-page (screenshot|only)|are\s+full-page/i);
    }
  });
});

// The Bun floor is engines.bun in package.json; the runtime guard reads it
// there. The docs, the openspec notes and CI state it by hand, and a bump that
// missed one would go unnoticed. Every statement must name the floor, and each
// file must keep at least one, so a deleted statement fails too.
describe("every statement of the Bun floor names engines.bun", () => {
  const floor = pkg.engines.bun.replace(/^>=\s*/, "");
  const FLOOR_FILES = [
    "README.md",
    "skills/bowser/SKILL.md",
    ".github/workflows/test.yml",
    "openspec/config.yaml",
    "openspec/specs/GLOSSARY.md",
  ];
  for (const file of FLOOR_FILES) {
    test(file, () => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const stated = [...text.matchAll(/Bun\s*(?:≥|>=)\s*([\d.]+)|bun-version:\s*"?>=\s*([\d.]+)/g)].map((m) =>
        (m[1] ?? m[2]!).replace(/\.$/, ""),
      );
      expect(stated.length).toBeGreaterThan(0);
      expect(stated.filter((v) => v !== floor)).toEqual([]);
    });
  }
});
