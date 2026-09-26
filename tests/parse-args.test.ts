import { describe, expect, test } from "bun:test";
import { parse, str, type Schemas } from "../src/cli/parser.ts";
import { reportFailure, run } from "../src/cli.ts";
import { SCHEMAS } from "../src/cli/registry.ts";

describe("parse", () => {
  test("-- ends options: later words are positionals even if they start with -", () => {
    const r = parse(SCHEMAS, ["--json", "fill", "--", "e1", "--json"]);
    expect(r.json).toBe(true);
    expect(r.command).toBe("fill");
    expect(r.positional).toEqual(["e1", "--json"]);
    expect(r.flags).toEqual({});
  });
  test("after --, --stdin, -s and a second -- are positionals too", () => {
    const r = parse(SCHEMAS, ["fill", "e1", "--", "--stdin"]);
    expect(r.positional).toEqual(["e1", "--stdin"]);
    expect(r.flags).toEqual({});
    expect(parse(SCHEMAS, ["fill", "--", "-s", "--"]).positional).toEqual(["-s", "--"]);
    expect(parse(SCHEMAS, ["fill", "--", "-s", "x"]).session).toBe("default");
  });
  test("-- before the command still finds the command", () => {
    const r = parse(SCHEMAS, ["--", "fill", "e1"]);
    expect(r.command).toBe("fill");
    expect(r.positional).toEqual(["e1"]);
  });
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
  test("open --persistent boolean flag", () => {
    const r = parse(SCHEMAS, ["open", "--persistent"]);
    expect(r.flags.persistent).toBe(true);
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

describe("a removed command", () => {
  // install and the cookie commands went with the second engine: bowser is
  // WebKit only. Each is now an ordinary unknown command, a user error
  // (exit 1), before any daemon work.
  for (const name of ["install", "cookie-list", "cookie-get", "cookie-set", "cookie-delete", "cookie-clear"]) {
    test(`${name} is an unknown command, exit 1`, async () => {
      const err = await run([name]).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`unknown command: ${name}`);
      expect(reportFailure(err).code).toBe(1);
    });
  }
});

describe("an enum flag", () => {
  // No command declares one today; the parser's support is pinned on a
  // schema of its own.
  const schemas: Schemas = {
    global: [],
    commands: [{
      name: "pick",
      positional: [],
      flags: [
        { name: "size", kind: "string", values: ["S", "M", "L"] },
        { name: "note", kind: "string" },
      ],
    }],
  };

  test("rejects a value outside its list", () => {
    expect(() => parse(schemas, ["pick", "--size=XL"])).toThrow("invalid --size: must be one of S, M, L");
  });

  test("accepts each of its values", () => {
    for (const v of ["S", "M", "L"]) {
      expect(parse(schemas, ["pick", `--size=${v}`]).flags.size).toBe(v);
    }
  });

  test("does not constrain a flag with no values list", () => {
    expect(parse(schemas, ["pick", "--note=anything"]).flags.note).toBe("anything");
  });
});

describe("str()", () => {
  test("returns a string flag's value", () => {
    expect(str({ domain: "example.com" }, "domain")).toBe("example.com");
  });

  test("returns undefined for a flag that was never passed", () => {
    expect(str({}, "domain")).toBeUndefined();
  });

  test("returns undefined for a boolean flag rather than handing over `true`", () => {
    // This is the whole reason str() exists. `flags.secure as string |
    // undefined` compiles and yields the boolean, so a command reading a
    // boolean flag as a string would receive true and pass it on.
    expect(str({ secure: true }, "secure")).toBeUndefined();
    expect(str({ secure: false }, "secure")).toBeUndefined();
  });
});
