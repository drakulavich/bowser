export type FlagKind = "string" | "boolean";

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  short?: string;
  /** What the value looks like, for `--help`: the accepted values of an enum
   *  flag, or the unit of a number. Written the way it should read after the
   *  `=`, so a literal set of values goes bare (`Lax|Strict|None`) and a
   *  stand-in the caller fills in goes in angle brackets (`<unix-seconds>`).
   *  Defaults to the flag's own name. Parsing ignores it. An enum flag should
   *  use `values` instead, which drives the placeholder and the parser from
   *  one list. */
  placeholder?: string;
  /** Accepted values for an enum flag. The parser rejects anything else, and
   *  `--help` derives the placeholder from this same list, so what is shown
   *  and what is accepted cannot drift. */
  values?: string[];
}

export interface CommandSchema {
  name: string;
  positional: { name: string; required: boolean }[];
  flags: FlagSpec[];
}

export interface Schemas {
  global: FlagSpec[];
  commands: CommandSchema[];
}

export interface Parsed {
  session: string;
  json: boolean;
  help: boolean;
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const GLOBAL_NAMES = new Set(["session", "json", "help"]);

export function parse(schemas: Schemas, argv: string[]): Parsed {
  const out: Parsed = {
    session: "default",
    json: false,
    help: false,
    command: undefined,
    positional: [],
    flags: {},
  };

  let i = 0;
  let cmdSchema: CommandSchema | undefined;

  while (i < argv.length) {
    const a = argv[i]!;

    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const spec = findFlag(schemas, cmdSchema, name);
      if (!spec) throw new Error(`unknown flag: --${name}`);
      const value =
        spec.kind === "boolean"
          ? (eq >= 0 ? a.slice(eq + 1) === "true" : true)
          : (eq >= 0 ? a.slice(eq + 1) : (argv[++i] ?? ""));
      assignFlag(out, spec, value);
      i++;
      continue;
    }

    if (a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      const short = eq >= 0 ? a.slice(1, eq) : a.slice(1);
      const spec = findShort(schemas, cmdSchema, short);
      if (!spec) throw new Error(`unknown flag: -${short}`);
      const value =
        spec.kind === "boolean"
          ? (eq >= 0 ? a.slice(eq + 1) === "true" : true)
          : (eq >= 0 ? a.slice(eq + 1) : (argv[++i] ?? ""));
      assignFlag(out, spec, value);
      i++;
      continue;
    }

    if (!out.command) {
      out.command = a;
      cmdSchema = schemas.commands.find((c) => c.name === a);
      if (!cmdSchema && !out.help) throw new Error(`unknown command: ${a}`);
      i++;
      continue;
    }
    out.positional.push(a);
    i++;
  }

  return out;
}

function findFlag(s: Schemas, cmd: CommandSchema | undefined, name: string): FlagSpec | undefined {
  return s.global.find((f) => f.name === name) ?? cmd?.flags.find((f) => f.name === name);
}
function findShort(s: Schemas, cmd: CommandSchema | undefined, short: string): FlagSpec | undefined {
  return s.global.find((f) => f.short === short) ?? cmd?.flags.find((f) => f.short === short);
}
function assignFlag(out: Parsed, spec: FlagSpec, value: string | boolean): void {
  // Both the --long and -short branches land here, so one check covers both.
  // No command prefix in the message: global flags belong to no command, and
  // a prefix that appears only sometimes reads worse than one that never does.
  if (spec.values && typeof value === "string" && !spec.values.includes(value)) {
    throw new Error(`invalid --${spec.name}: must be one of ${spec.values.join(", ")}`);
  }
  if (GLOBAL_NAMES.has(spec.name)) {
    if (spec.name === "session") out.session = String(value);
    else if (spec.name === "json") out.json = Boolean(value);
    else if (spec.name === "help") out.help = Boolean(value);
    return;
  }
  out.flags[spec.name] = value;
}

/** Read a string flag. A `Command`'s `run` receives flags as
 *  `Record<string, string | boolean>`, because one bag holds both kinds; this
 *  narrows one back to what its `FlagSpec` declared. Prefer it to `as string |
 *  undefined`: the cast also silently accepts a boolean, so declaring a flag
 *  `kind: "boolean"` and then reading it as a string would compile and hand
 *  the command `true`. Lives here rather than beside `Command` because
 *  registry.ts imports the command modules, so importing a value back from it
 *  would be a cycle. */
export function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
