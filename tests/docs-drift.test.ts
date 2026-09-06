// The registry is the source of truth for what commands exist; README and
// SKILL.md are hand-written. This catches the case where a command is added
// and the docs are not.
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

describe("docs list every command", () => {
  test("README", () => {
    expect(COMMANDS.filter((c) => !documented(README, c.name)).map((c) => c.name)).toEqual([]);
  });

  test("SKILL.md", () => {
    expect(COMMANDS.filter((c) => !documented(SKILL, c.name)).map((c) => c.name)).toEqual([]);
  });
});
