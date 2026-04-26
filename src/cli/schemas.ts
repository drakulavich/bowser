import type { Schemas } from "./parser.ts";

export const SCHEMAS: Schemas = {
  global: [
    { name: "session", short: "s", kind: "string" },
    { name: "json", kind: "boolean" },
    { name: "help", short: "h", kind: "boolean" },
  ],
  commands: [
    { name: "install",     positional: [],                                                   flags: [{ name: "force", short: "f", kind: "boolean" }] },
    { name: "open",        positional: [{ name: "url", required: false }],                   flags: [] },
    { name: "goto",        positional: [{ name: "url", required: true }],                    flags: [] },
    { name: "close",       positional: [],                                                   flags: [] },
    { name: "snapshot",    positional: [],                                                   flags: [{ name: "filename", kind: "string" }, { name: "depth", kind: "string" }] },
    { name: "click",       positional: [{ name: "ref", required: true }],                    flags: [] },
    { name: "fill",        positional: [{ name: "ref", required: true }, { name: "text", required: true }], flags: [] },
    { name: "type",        positional: [{ name: "text", required: true }],                   flags: [] },
    { name: "press",       positional: [{ name: "key", required: true }],                    flags: [] },
    { name: "hover",       positional: [{ name: "ref", required: true }],                    flags: [] },
    { name: "select",      positional: [{ name: "ref", required: true }, { name: "value", required: true }], flags: [] },
    { name: "check",       positional: [{ name: "ref", required: true }],                    flags: [] },
    { name: "uncheck",     positional: [{ name: "ref", required: true }],                    flags: [] },
    { name: "screenshot",  positional: [{ name: "ref", required: false }],                   flags: [{ name: "filename", kind: "string" }] },
    { name: "go-back",     positional: [],                                                   flags: [] },
    { name: "go-forward",  positional: [],                                                   flags: [] },
    { name: "reload",      positional: [],                                                   flags: [] },
    { name: "list",        positional: [],                                                   flags: [] },
  ],
};
