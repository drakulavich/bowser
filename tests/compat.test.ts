import { describe, expect, test } from "bun:test";
import { parse } from "../src/cli/parser.ts";
import { SCHEMAS } from "../src/cli/schemas.ts";

const CASES: { argv: string[]; expect: { command: string; session?: string; positional?: string[]; flags?: Record<string, string | boolean> } }[] = [
  { argv: ["open", "https://x"],                              expect: { command: "open",       positional: ["https://x"] } },
  { argv: ["-s=app", "open", "https://x"],                    expect: { command: "open",       session: "app" } },
  { argv: ["-s", "app", "snapshot"],                          expect: { command: "snapshot",   session: "app" } },
  { argv: ["snapshot", "--filename=out.yml"],                 expect: { command: "snapshot",   flags: { filename: "out.yml" } } },
  { argv: ["snapshot", "--depth=3"],                          expect: { command: "snapshot",   flags: { depth: "3" } } },
  { argv: ["click", "e3"],                                    expect: { command: "click",      positional: ["e3"] } },
  { argv: ["fill", "e1", "hello world"],                      expect: { command: "fill",       positional: ["e1", "hello world"] } },
  { argv: ["press", "Enter"],                                 expect: { command: "press",      positional: ["Enter"] } },
  { argv: ["hover", "e2"],                                    expect: { command: "hover",      positional: ["e2"] } },
  { argv: ["select", "e3", "red"],                            expect: { command: "select",     positional: ["e3", "red"] } },
  { argv: ["check", "e4"],                                    expect: { command: "check",      positional: ["e4"] } },
  { argv: ["uncheck", "e4"],                                  expect: { command: "uncheck",    positional: ["e4"] } },
  { argv: ["screenshot"],                                     expect: { command: "screenshot" } },
  { argv: ["screenshot", "--filename=shot.png"],              expect: { command: "screenshot", flags: { filename: "shot.png" } } },
  { argv: ["screenshot", "e2", "--filename=el.png"],          expect: { command: "screenshot", positional: ["e2"], flags: { filename: "el.png" } } },
  { argv: ["go-back"],                                        expect: { command: "go-back" } },
  { argv: ["go-forward"],                                     expect: { command: "go-forward" } },
  { argv: ["reload"],                                         expect: { command: "reload" } },
  { argv: ["list"],                                           expect: { command: "list" } },
  { argv: ["install", "--force"],                             expect: { command: "install",    flags: { force: true } } },
  { argv: ["localstorage-list"],                              expect: { command: "localstorage-list" } },
  { argv: ["localstorage-get", "tok"],                        expect: { command: "localstorage-get",    positional: ["tok"] } },
  { argv: ["localstorage-set", "tok", "val"],                 expect: { command: "localstorage-set",    positional: ["tok", "val"] } },
  { argv: ["localstorage-delete", "tok"],                     expect: { command: "localstorage-delete", positional: ["tok"] } },
  { argv: ["localstorage-clear"],                             expect: { command: "localstorage-clear" } },
  { argv: ["sessionstorage-list"],                            expect: { command: "sessionstorage-list" } },
  { argv: ["sessionstorage-get", "tok"],                      expect: { command: "sessionstorage-get",    positional: ["tok"] } },
  { argv: ["sessionstorage-set", "tok", "val"],               expect: { command: "sessionstorage-set",    positional: ["tok", "val"] } },
  { argv: ["sessionstorage-delete", "tok"],                   expect: { command: "sessionstorage-delete", positional: ["tok"] } },
  { argv: ["sessionstorage-clear"],                           expect: { command: "sessionstorage-clear" } },
];

describe("playwright-cli compat parse table", () => {
  for (const c of CASES) {
    test(c.argv.join(" "), () => {
      const r = parse(SCHEMAS, c.argv);
      expect(r.command).toBe(c.expect.command);
      if (c.expect.session) expect(r.session).toBe(c.expect.session);
      if (c.expect.positional) expect(r.positional).toEqual(c.expect.positional);
      if (c.expect.flags) {
        for (const [k, v] of Object.entries(c.expect.flags)) {
          expect(r.flags[k]).toBe(v);
        }
      }
    });
  }
});
