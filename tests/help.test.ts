// --help is generated from the registry. These pin the parts an agent reads:
// every command appears exactly once, with its argument shape and summary.
import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/cli/registry.ts";
import { renderHelp } from "../src/cli/help.ts";

const HELP = renderHelp(COMMANDS);

describe("generated help", () => {
  test("lists every command exactly once, in registry order", () => {
    const listed = HELP.split("\n")
      .map((l) => l.match(/^  ([a-z][a-z-]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(listed).toEqual(COMMANDS.map((c) => c.name));
  });

  test("shows required positionals in <> and optional in []", () => {
    expect(HELP).toContain("goto <url>");
    expect(HELP).toContain("open [url]");
    expect(HELP).toContain("fill <ref> <text>");
  });

  test("shows flags, with a value placeholder for string flags", () => {
    expect(HELP).toContain("[--all]");
    expect(HELP).toContain("[--filename=<filename>]");
  });

  test("a flag's placeholder carries its accepted values into the usage", () => {
    expect(HELP).toContain("[--same-site=Lax|Strict|None]");
    expect(HELP).toContain("[--expires=<unix-seconds>]");
  });

  test("every summary appears", () => {
    for (const c of COMMANDS) expect(HELP).toContain(c.summary);
  });

  test("keeps the header and the global flags block", () => {
    expect(HELP.startsWith("bowser — drop-in playwright-cli alternative for AI agents")).toBe(true);
    expect(HELP).toContain("Global flags:");
    expect(HELP).toContain('-s, --session <name>     session name (default: "default")');
    expect(HELP).toContain("--json               machine-readable output");
    expect(HELP).toContain("-h, --help               show this help");
  });
});
