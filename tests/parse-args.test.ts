import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("defaults", () => {
    const a = parseArgs([]);
    expect(a.session).toBe("default");
    expect(a.json).toBe(false);
    expect(a.help).toBe(false);
    expect(a.command).toBeUndefined();
  });

  test("command + positional", () => {
    const a = parseArgs(["open", "https://example.com"]);
    expect(a.command).toBe("open");
    expect(a.positional).toEqual(["https://example.com"]);
  });

  test("--session overrides default", () => {
    const a = parseArgs(["--session", "login", "open", "https://x.com"]);
    expect(a.session).toBe("login");
    expect(a.command).toBe("open");
    expect(a.positional).toEqual(["https://x.com"]);
  });

  test("--json flag", () => {
    const a = parseArgs(["--json", "snap"]);
    expect(a.json).toBe(true);
    expect(a.command).toBe("snap");
  });

  test("-i flag", () => {
    const a = parseArgs(["snap", "-i"]);
    expect(a.interactive).toBe(true);
  });

  test("help flags", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("fill with two positional args", () => {
    const a = parseArgs(["fill", "@e5", "hello world"]);
    expect(a.command).toBe("fill");
    expect(a.positional).toEqual(["@e5", "hello world"]);
  });
});
