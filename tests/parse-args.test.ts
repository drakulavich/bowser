import { describe, expect, test } from "bun:test";
import { parse, str } from "../src/cli/parser.ts";
import { run } from "../src/cli.ts";
import { SCHEMAS } from "../src/cli/registry.ts";

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

describe("run() rejects an invalid enum value before reaching a browser", () => {
  // The only assertion covering the reported case through the real argv path:
  // the e2e cookie tests call the command functions directly and never parse
  // a command line, so nothing else exercises this. parse() throws before any
  // daemon work, which is what keeps this a unit test — the sibling assertion
  // for a *valid* value would reach a real browser, and belongs (and already
  // lives) in the parse() tests below.
  test("cookie-set --same-site=garbage never reaches the daemon", async () => {
    await expect(run(["cookie-set", "k", "v", "--same-site=garbage"]))
      .rejects.toThrow("invalid --same-site: must be one of Strict, Lax, None");
  });
});

describe("an enum flag", () => {
  test("rejects a value outside its list", () => {
    expect(() => parse(SCHEMAS, ["cookie-set", "k", "v", "--same-site=garbage"]))
      .toThrow("invalid --same-site: must be one of Strict, Lax, None");
  });

  test("accepts each of its values", () => {
    for (const v of ["Strict", "Lax", "None"]) {
      const p = parse(SCHEMAS, ["cookie-set", "k", "v", `--same-site=${v}`]);
      expect(p.flags["same-site"]).toBe(v);
    }
  });

  test("does not constrain a flag with no values list", () => {
    const p = parse(SCHEMAS, ["cookie-set", "k", "v", "--domain=anything.example"]);
    expect(p.flags.domain).toBe("anything.example");
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
