// Import-rule test. Cheap stand-in for a dependency linter: reads every
// src/**/*.ts and checks the layering rules from the maintainability spec
// (docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md,
// Section 1). Only rules that hold today are listed; each refactor PR adds
// the rules its layout makes true.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Module specifiers of value imports (type-only imports are ignored). Catches
 *  `import "x"`, `import 'x'`, `import ... from "x"` and `import ... from 'x'`. */
function valueImports(text: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\b)(?:[^;'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

interface Rule {
  name: string;
  /** True when this file breaks the rule. `file` is repo-relative. */
  violates(file: string, text: string): boolean;
}

const RULES: Rule[] = [
  {
    name: "only src/browser.ts instantiates Bun.WebView",
    // Future: tighten this to "only src/browser.ts mentions Bun.WebView" once
    // other modules stop referencing it in comments (daemon.ts, commands.ts, etc).
    violates: (file, text) => file !== "src/browser.ts" && /new\s+Bun\.WebView\s*\(/.test(text),
  },
  {
    name: "only src/daemon/server.ts calls openBrowser",
    // browser.ts is exempt because the regex also matches its own definition site.
    violates: (file, text) => file !== "src/daemon/server.ts" && file !== "src/browser.ts" && /\bopenBrowser\s*\(/.test(text),
  },
  {
    name: "backend.ts, snapshot.ts, serialize.ts, socket-write.ts and daemon/protocol.ts have no value imports from src",
    violates: (file, text) =>
      ["src/backend.ts", "src/snapshot.ts", "src/serialize.ts", "src/socket-write.ts", "src/daemon/protocol.ts"].includes(file) &&
      valueImports(text).some((s) => s.startsWith("./") || s.startsWith("../")),
  },
  {
    name: "commands.ts talks to the daemon only through client.ts and protocol.ts",
    violates: (file, text) =>
      file === "src/commands.ts" &&
      valueImports(text).some((s) => s.endsWith("browser.ts") || s.endsWith("daemon/server.ts")),
  },
  {
    name: "daemon/client.ts does not import browser.ts (backend checks come from backend.ts)",
    violates: (file, text) =>
      file === "src/daemon/client.ts" && valueImports(text).some((s) => s.endsWith("browser.ts")),
  },
];

describe("src layering rules", () => {
  const files = sources(SRC).map((p) => ({ file: relative(ROOT, p), text: readFileSync(p, "utf8") }));
  for (const rule of RULES) {
    test(rule.name, () => {
      const violators = files.filter((f) => rule.violates(f.file, f.text)).map((f) => f.file);
      expect(violators).toEqual([]);
    });
  }
});
