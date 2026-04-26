export type FlagKind = "string" | "boolean";

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  short?: string;
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
  if (GLOBAL_NAMES.has(spec.name)) {
    if (spec.name === "session") out.session = String(value);
    else if (spec.name === "json") out.json = Boolean(value);
    else if (spec.name === "help") out.help = Boolean(value);
    return;
  }
  out.flags[spec.name] = value;
}
