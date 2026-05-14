import { describe, expect, test } from "bun:test";
import { parse } from "../src/cli/parser.ts";
import { SCHEMAS } from "../src/cli/schemas.ts";

describe("parse", () => {
  test("global session via -s=name", () => {
    const r = parse(SCHEMAS, ["-s=app", "open", "https://x"]);
    expect(r.session).toBe("app");
    expect(r.command).toBe("open");
    expect(r.positional).toEqual(["https://x"]);
  });
  test("global session via -s name (space)", () => {
    const r = parse(SCHEMAS, ["-s", "app", "open"]);
    expect(r.session).toBe("app");
  });
  test("global session via --session=name", () => {
    const r = parse(SCHEMAS, ["--session=app", "open"]);
    expect(r.session).toBe("app");
  });
  test("global session via --session name", () => {
    const r = parse(SCHEMAS, ["--session", "app", "open"]);
    expect(r.session).toBe("app");
  });
  test("default session is 'default'", () => {
    expect(parse(SCHEMAS, ["open"]).session).toBe("default");
  });
  test("--json is a global flag", () => {
    expect(parse(SCHEMAS, ["--json", "snapshot"]).json).toBe(true);
  });
  test("--filename=path on snapshot", () => {
    const r = parse(SCHEMAS, ["snapshot", "--filename=out.yml"]);
    expect(r.flags.filename).toBe("out.yml");
  });
  test("--filename path (space form)", () => {
    const r = parse(SCHEMAS, ["snapshot", "--filename", "out.yml"]);
    expect(r.flags.filename).toBe("out.yml");
  });
  test("install --force boolean flag", () => {
    const r = parse(SCHEMAS, ["install", "--force"]);
    expect(r.flags.force).toBe(true);
  });
  test("click <ref> positional", () => {
    const r = parse(SCHEMAS, ["click", "e3"]);
    expect(r.command).toBe("click");
    expect(r.positional).toEqual(["e3"]);
  });
  test("fill <ref> <text> positionals", () => {
    const r = parse(SCHEMAS, ["fill", "e1", "hello world"]);
    expect(r.positional).toEqual(["e1", "hello world"]);
  });
  test("--help on a command sets help flag", () => {
    expect(parse(SCHEMAS, ["snapshot", "--help"]).help).toBe(true);
  });
  test("-h sets help flag", () => {
    expect(parse(SCHEMAS, ["-h"]).help).toBe(true);
  });
  test("unknown command throws", () => {
    expect(() => parse(SCHEMAS, ["frob"])).toThrow(/unknown command/);
  });
  test("unknown flag for command throws", () => {
    expect(() => parse(SCHEMAS, ["snapshot", "--bogus"])).toThrow(/unknown flag/);
  });
  test("--depth=N on snapshot is parsed", () => {
    expect(parse(SCHEMAS, ["snapshot", "--depth=3"]).flags.depth).toBe("3");
  });
});
