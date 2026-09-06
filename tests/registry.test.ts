// The registry is the single source for dispatch, help and MCP. These pin the
// properties every consumer relies on.
import { describe, expect, test } from "bun:test";
import { COMMANDS, SCHEMAS, findCommand } from "../src/cli/registry.ts";

describe("command registry", () => {
  test("every command has a name, a summary and a run", () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z][a-z-]*$/);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.summary.endsWith(".")).toBe(false);
      expect(typeof c.run).toBe("function");
    }
  });

  test("names are unique", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("SCHEMAS.commands is derived from COMMANDS, in the same order", () => {
    expect(SCHEMAS.commands.map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    for (const c of COMMANDS) {
      const s = SCHEMAS.commands.find((x) => x.name === c.name)!;
      expect(s.positional).toEqual(c.positional);
      expect(s.flags).toEqual(c.flags);
    }
  });

  test("findCommand is by exact name", () => {
    expect(findCommand("go-back")?.name).toBe("go-back");
    expect(findCommand("nope")).toBeUndefined();
    // A prototype key must not resolve to a command.
    expect(findCommand("toString")).toBeUndefined();
  });

  test("required positionals precede optional ones", () => {
    for (const c of COMMANDS) {
      const firstOptional = c.positional.findIndex((p) => !p.required);
      if (firstOptional === -1) continue;
      expect(c.positional.slice(firstOptional).every((p) => !p.required)).toBe(true);
    }
  });
});
