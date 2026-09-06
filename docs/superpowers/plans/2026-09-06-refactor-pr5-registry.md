# Refactor PR 5: the command registry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one `Command` object per command, living beside its implementation, becomes the single source for dispatch, `--help`, and the MCP tool list. The 45-case switch in `cli.ts`, the hand-written `HELP` string, `DESCRIPTIONS` and `MCP_EXCLUDED` in `mcp.ts`, and the hand-maintained `SCHEMAS.commands` array all disappear.

**Architecture:** Each `src/commands/<domain>.ts` exports `COMMANDS: readonly Command[]` alongside its `cmd*` functions. `src/cli/registry.ts` concatenates them in the order `--help` should print, derives `SCHEMAS` from them, and exposes `findCommand(name)`. A `Command` carries its name, one-line `summary`, positionals, flags, an `mcp?: false` opt-out, and a `run(ctx, args)` that unpacks its own flags. `cli.ts` becomes parse → find → run. `HELP` is generated from the same objects. `buildTools()` reads `summary`. A drift test asserts every command appears in README and SKILL.md.

**Tech Stack:** Bun 1.4.0, TypeScript 7.0.2 (`bun run typecheck` is the gate), bun:test. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` — Section 3 (the registry, its four consumers, the drift test), Section 1 (`cli/registry.ts` in the layout), "The contract" (`--help` text and MCP descriptions are known to change; command names and argv shapes are pinned by `tests/compat.test.ts`).

## Global Constraints

- Zero runtime dependencies. Command names, argv shapes, exit codes, every command's stdout and `--json` shape are unchanged. `tests/compat.test.ts` and `tests/parse-args.test.ts` keep importing `SCHEMAS` and must pass untouched.
- Deliberately allowed to change, and only these: the `bowser --help` text, and MCP tool descriptions (both now generated from `summary`). Every change is listed in CHANGELOG.
- `cli.ts` keeps its `import.meta.main` block exactly as it is: the `--daemon` intercept, the `mcp` intercept, and the exit-code regex. Only the body of `run()` and the `HELP` constant change.
- `mcp` stays a registry entry with `mcp: false` and a `run` that throws today's exact message, so `run(["mcp"])` behaves as it does now.
- `install` keeps `mcp: false` (today's `MCP_EXCLUDED`).
- Every commit carries the trailer lines `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj`.
- Per-task gate: `bun run typecheck && bun test` (316 pass at the start). Task 5 also runs both e2e suites and the compiled-binary smoke, because `cli.ts` changes.

---

### Task 1: `Command` and the registry, with `SCHEMAS` derived

**Files:**
- Create: `src/cli/registry.ts`
- Modify: `src/cli/schemas.ts` (becomes a re-export)
- Modify: each `src/commands/<domain>.ts` (add its `COMMANDS`)
- Create: `tests/registry.test.ts`

**Interfaces:**
- Produces, from `src/cli/registry.ts`:

```ts
import type { CommandSchema, FlagSpec, Schemas } from "./parser.ts";
import type { CommandContext } from "../commands/context.ts";

export interface Positional { name: string; required: boolean }
export interface CommandArgs { positional: string[]; flags: Record<string, string | boolean> }

export interface Command {
  name: string;
  /** One line, imperative, no trailing period. Feeds `--help` and the MCP tool description. */
  summary: string;
  positional: Positional[];
  flags: FlagSpec[];
  /** Omit from `bowser mcp`. Replaces MCP_EXCLUDED. */
  mcp?: false;
  run(ctx: CommandContext, args: CommandArgs): Promise<string>;
}

export const COMMANDS: readonly Command[];
export function findCommand(name: string): Command | undefined;
export const SCHEMAS: Schemas;
```

- Consumed by: `cli.ts` (Task 2), `mcp.ts` (Task 3).

- [ ] **Step 1: Write the failing test**

`tests/registry.test.ts`:

```ts
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
```

Run: `bun test tests/registry.test.ts` → fails to import.

- [ ] **Step 2: Add `COMMANDS` to each domain module**

In each `src/commands/<domain>.ts`, append an exported `COMMANDS` whose entries wrap the existing `cmd*` functions. The `run` bodies contain exactly the flag unpacking that `src/cli.ts`'s switch does today — copy each case's expression verbatim. Positionals come from `args.positional`; today's switch reads `const [p0, p1] = args.positional` and passes `p0 ?? ""`, so keep the `?? ""`.

`navigation.ts`:

```ts
export const COMMANDS: Command[] = [
  {
    name: "open",
    summary: "Start or attach to a session; navigate if a URL is given",
    positional: [{ name: "url", required: false }],
    flags: [],
    run: (ctx, a) => cmdOpen(ctx, a.positional[0]),
  },
  {
    name: "goto",
    summary: "Navigate the current session to a URL",
    positional: [{ name: "url", required: true }],
    flags: [],
    run: (ctx, a) => cmdGoto(ctx, a.positional[0] ?? ""),
  },
  {
    name: "close",
    summary: "Close a session (or all sessions with --all)",
    positional: [{ name: "session", required: false }],
    flags: [{ name: "all", kind: "boolean" }],
    run: (ctx, a) => cmdClose(ctx, { name: a.positional[0], all: Boolean(a.flags.all) }),
  },
  {
    name: "go-back",
    summary: "Navigate back in history",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "back"),
  },
  {
    name: "go-forward",
    summary: "Navigate forward in history",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "forward"),
  },
  {
    name: "reload",
    summary: "Reload the current page",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "reload"),
  },
  {
    name: "list",
    summary: "List sessions",
    positional: [], flags: [],
    run: (ctx) => cmdList(ctx),
  },
];
```

The `summary` for each command is **today's `DESCRIPTIONS` entry in `src/mcp.ts`**, verbatim, for every command that has one. `install` and `mcp` have no `DESCRIPTIONS` entry; use `"Download a headless Chromium"` and `"Run a Model Context Protocol stdio server exposing commands as tools"`. `list`'s `DESCRIPTIONS` entry is `"List active sessions"`, but `cmdList` enumerates session directories including closed ones, so use `"List sessions"` (matching today's HELP) and note the change in the CHANGELOG.

The other modules follow the same shape, wrapping: `interaction.ts` → click, fill, type, press, hover, select, check, uncheck, resize; `snapshot.ts` → snapshot, screenshot; `web-storage.ts` → the ten storage commands; `scripting.ts` → eval, run-code; `cookies.ts` → the five cookie commands; `storage-state.ts` → state-save, state-load; `install.ts` → install (with `mcp: false`).

The flag unpacking that moves out of `cli.ts` and into a `run`, verbatim from today's switch:

```ts
// snapshot
run: (ctx, a) => cmdSnapshot(ctx, {
  filename: a.flags.filename as string | undefined,
  depth: a.flags.depth as string | undefined,
}),
// screenshot
run: (ctx, a) => cmdScreenshot(ctx, { filename: a.flags.filename as string | undefined }),
// install
run: (ctx, a) => cmdInstall(ctx, { force: Boolean(a.flags.force) }),
// cookie-list / cookie-get
run: (ctx, a) => cmdCookieList(ctx, {
  domain: a.flags.domain as string | undefined,
  url:    a.flags.url    as string | undefined,
}),
// cookie-set
run: (ctx, a) => cmdCookieSet(ctx, a.positional[0] ?? "", a.positional[1] ?? "", {
  domain:   a.flags.domain    as string | undefined,
  url:      a.flags.url       as string | undefined,
  path:     a.flags.path      as string | undefined,
  httpOnly: a.flags["http-only"] ? true : undefined,
  secure:   a.flags.secure       ? true : undefined,
  sameSite: a.flags["same-site"] as "Strict" | "Lax" | "None" | undefined,
  expires:  a.flags.expires !== undefined ? Number(a.flags.expires) : undefined,
}),
// cookie-delete
run: (ctx, a) => cmdCookieDelete(ctx, a.positional[0] ?? "", {
  domain: a.flags.domain as string | undefined,
  url:    a.flags.url    as string | undefined,
  path:   a.flags.path   as string | undefined,
}),
```

The tri-state `httpOnly`/`secure` unpacking is load-bearing: `tests/cookie.test.ts` asserts an absent flag leaves the key unset. Copy it exactly.

- [ ] **Step 3: Write `src/cli/registry.ts`**

```ts
// The command registry: one Command per command, contributed by the module
// that implements it. Dispatch (cli.ts), --help (cli.ts) and the MCP tool
// list (mcp.ts) all read this, so a command cannot exist in one and not the
// others. SCHEMAS is derived here; the parser still owns argv parsing.

import type { Schemas } from "./parser.ts";
import { COMMANDS as COOKIES } from "../commands/cookies.ts";
// … one import per domain module …

/** Order is the order `--help` prints. */
export const COMMANDS: readonly Command[] = [
  ...INSTALL, ...NAVIGATION_OPEN_GROUP, …
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export const SCHEMAS: Schemas = {
  global: [
    { name: "session", short: "s", kind: "string" },
    { name: "json", kind: "boolean" },
    { name: "help", short: "h", kind: "boolean" },
  ],
  commands: COMMANDS.map((c) => ({ name: c.name, positional: c.positional, flags: c.flags })),
};
```

`COMMANDS` must list the commands in exactly today's `SCHEMAS.commands` order: install, open, goto, close, snapshot, click, fill, type, press, hover, select, check, uncheck, screenshot, resize, go-back, go-forward, reload, list, the five localstorage, the five sessionstorage, eval, run-code, cookie-list, cookie-get, cookie-set, cookie-delete, cookie-clear, state-save, state-load, mcp. Because a module's own `COMMANDS` cannot be interleaved, spread them in whatever grouping reproduces that sequence; if a module's internal order needs to differ from its file order, order the array inside the module, not here.

`findCommand` uses `Array.find`, not an object lookup, so a prototype key cannot resolve (the test pins this).

`src/cli/schemas.ts` becomes:

```ts
// SCHEMAS now lives with the registry it is derived from. This re-export
// keeps tests/compat.test.ts, tests/parse-args.test.ts and tests/cookie.test.ts
// importing the path they always did.
export { SCHEMAS } from "./registry.ts";
```

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 321 pass (316 + 5 registry tests). `tests/compat.test.ts` and `tests/parse-args.test.ts` pass unchanged — that is the proof the derived `SCHEMAS` matches the hand-written one.

```bash
git add src/cli/registry.ts src/cli/schemas.ts src/commands tests/registry.test.ts
git commit -m "feat: one Command per command, contributed by the module that implements it

SCHEMAS is now derived from COMMANDS rather than maintained beside it.
The flag unpacking moves from cli.ts's switch into each command's run,
next to the schema that declares the flag. Dispatch still goes through
the switch until the next commit."
```

---

### Task 2: dispatch and `--help` from the registry

**Files:**
- Modify: `src/cli.ts` (delete the switch and the `HELP` string; add `renderHelp`)
- Create: `tests/help.test.ts`

**Interfaces:**
- Produces: `export function renderHelp(commands: readonly Command[]): string` in `src/cli/help.ts`.

- [ ] **Step 1: Failing test**

`tests/help.test.ts`:

```ts
// --help is generated from the registry. These pin the parts an agent reads:
// every command appears exactly once, with its argument shape and summary.
import { describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/cli/registry.ts";
import { renderHelp } from "../src/cli/help.ts";

const HELP = renderHelp(COMMANDS);

describe("generated help", () => {
  test("lists every command exactly once, in registry order", () => {
    const listed = HELP.split("\n")
      .map((l) => l.match(/^  ([a-z][a-z-]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(listed).toEqual(COMMANDS.map((c) => c.name));
  });

  test("shows required positionals in <> and optional in []", () => {
    expect(HELP).toContain("goto <url>");
    expect(HELP).toContain("open [url]");
    expect(HELP).toContain("fill <ref> <text>");
  });

  test("shows flags, with a value placeholder for string flags", () => {
    expect(HELP).toContain("[--all]");
    expect(HELP).toContain("[--filename=<filename>]");
  });

  test("every summary appears", () => {
    for (const c of COMMANDS) expect(HELP).toContain(c.summary);
  });

  test("keeps the header and the global flags block", () => {
    expect(HELP.startsWith("bowser — drop-in playwright-cli alternative for AI agents")).toBe(true);
    expect(HELP).toContain("Global flags:");
    expect(HELP).toContain('-s, --session <name>     session name (default: "default")');
    expect(HELP).toContain("--json               machine-readable output");
    expect(HELP).toContain("-h, --help               show this help");
  });
});
```

- [ ] **Step 2: Write `src/cli/help.ts`**

```ts
// `bowser --help`, generated from the registry so a command cannot be
// missing from it. Layout: two-space indent, the usage (name plus its
// positionals and flags), then the summary in a column. A usage longer than
// the column wraps onto its own line with the summary on the next.

import type { Command } from "./registry.ts";

const HEADER = "bowser — drop-in playwright-cli alternative for AI agents";
const GLOBAL = `Global flags:
  -s, --session <name>     session name (default: "default")
      --json               machine-readable output
  -h, --help               show this help`;

/** Column the summaries start at. Usages at or past it wrap. */
const SUMMARY_COL = 37;

export function usageOf(c: Command): string {
  const parts = [c.name];
  for (const p of c.positional) parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  for (const f of c.flags) parts.push(f.kind === "boolean" ? `[--${f.name}]` : `[--${f.name}=<${f.name}>]`);
  return parts.join(" ");
}

export function renderHelp(commands: readonly Command[]): string {
  const lines = [HEADER, "", "Commands:"];
  for (const c of commands) {
    const usage = "  " + usageOf(c);
    if (usage.length < SUMMARY_COL) lines.push(usage.padEnd(SUMMARY_COL) + c.summary);
    else lines.push(usage, " ".repeat(SUMMARY_COL) + c.summary);
  }
  lines.push("", GLOBAL);
  return lines.join("\n");
}
```

- [ ] **Step 3: Rewrite `run()` in `src/cli.ts`**

Delete the `HELP` constant and the whole `switch`. `run` becomes:

```ts
export async function run(argv: string[]): Promise<string> {
  const args = parse(SCHEMAS, argv);
  if (!args.command) return renderHelp(COMMANDS);
  const command = findCommand(args.command);
  // parse() already rejects an unknown command; this is the type narrowing.
  if (!command) throw new Error(`unknown command: ${args.command}`);
  const ctx: CommandContext = { session: args.session, json: args.json };
  return command.run(ctx, { positional: args.positional, flags: args.flags });
}
```

Note `if (args.help && !args.command) return HELP;` and `if (!args.command) return HELP;` collapse into one line: both returned `HELP`. `bowser snapshot --help` is unchanged — it never reached that branch before either, and still runs the command. `cli.ts` now imports `COMMANDS`, `findCommand`, `SCHEMAS` from `./cli/registry.ts` and `renderHelp` from `./cli/help.ts`, plus `CommandContext`; every `cmd*` import disappears.

Keep the `import.meta.main` block byte-identical.

- [ ] **Step 4: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 326 pass (321 + 5 help tests). Then eyeball the new help text against the old one and record the diff for the CHANGELOG:

```bash
bun run src/cli.ts --help
```

```bash
git add src/cli.ts src/cli/help.ts tests/help.test.ts
git commit -m "feat: dispatch and --help come from the registry

The 45-case switch and the hand-written HELP string are gone. Adding a
command to a commands/*.ts COMMANDS array is now enough for the CLI to
dispatch it and for --help to list it."
```

---

### Task 3: MCP tools from the registry

**Files:**
- Modify: `src/mcp.ts` (delete `DESCRIPTIONS` and `MCP_EXCLUDED`; `buildTools` reads `COMMANDS`)
- Modify: `tests/mcp.test.ts` (the drift test becomes a summary test)

- [ ] **Step 1: Rewrite `buildTools`**

```ts
export function buildTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.mcp === false) continue;
    const properties: Record<string, JsonSchemaProp> = {};
    const required: string[] = [];
    for (const p of cmd.positional) {
      properties[p.name] = { type: "string", description: `${p.name} (positional argument)` };
      if (p.required) required.push(p.name);
    }
    for (const f of cmd.flags) {
      properties[f.name] = { type: f.kind === "boolean" ? "boolean" : "string", description: `--${f.name}` };
    }
    properties.session = { type: "string", description: 'bowser session name (default: "default")' };
    tools.push({ name: cmd.name, description: cmd.summary, inputSchema: { type: "object", properties, required } });
  }
  return tools;
}
```

Everything else in `mcp.ts` stays: `toArgv`, the JSON-RPC loop, `MCP_PROTOCOL_VERSION`, the stdout purity rule. The `tools/call` lookup currently does `SCHEMAS.commands.find(...)`; switch it to `findCommand(name)` and pass the command's own positional/flag shape to `toArgv` (its `CommandSchema` parameter is structurally satisfied by a `Command`).

- [ ] **Step 2: Update `tests/mcp.test.ts`**

Delete the `DESCRIPTIONS`/`MCP_EXCLUDED` imports. The drift test "every non-excluded command has a description" becomes:

```ts
test("every exposed tool has a non-empty summary as its description", () => {
  for (const t of buildTools()) {
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.description).toBe(findCommand(t.name)!.summary);
  }
});

test("mcp and install are not exposed as tools", () => {
  const names = buildTools().map((t) => t.name);
  expect(names).not.toContain("mcp");
  expect(names).not.toContain("install");
});
```

Every other test in the file (the `toArgv` round-trips, the JSON-RPC handshake) stays as it is. If one asserts a specific tool description string, update it to the `summary` and note it in the CHANGELOG.

- [ ] **Step 3: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 326 pass (the mcp drift test is replaced, not added to).

```bash
git add src/mcp.ts tests/mcp.test.ts
git commit -m "feat: MCP tool descriptions are the registry's summaries

DESCRIPTIONS and MCP_EXCLUDED are deleted; a command's summary is its
tool description and `mcp: false` is the opt-out. The list can no longer
drift from the CLI's."
```

---

### Task 4: docs drift test

**Files:**
- Create: `tests/docs-drift.test.ts`

- [ ] **Step 1: Write it**

```ts
// The registry is the source of truth for what commands exist; README and
// SKILL.md are hand-written. This catches the case where a command is added
// and the docs are not.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/cli/registry.ts";

const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SKILL = readFileSync(join(ROOT, "skills/bowser/SKILL.md"), "utf8");

/** A command counts as documented when its name appears in a code span. */
const documented = (text: string, name: string) =>
  new RegExp("`" + name.replace(/-/g, "\\-") + "[ `\\[<]").test(text);

describe("docs list every command", () => {
  test("README", () => {
    expect(COMMANDS.filter((c) => !documented(README, c.name)).map((c) => c.name)).toEqual([]);
  });

  test("SKILL.md", () => {
    expect(COMMANDS.filter((c) => !documented(SKILL, c.name)).map((c) => c.name)).toEqual([]);
  });
});
```

Run it. If a command is genuinely missing from either file, add the row or line — that is the test doing its job, and the addition belongs in this commit. If the regex misses a command that *is* documented in a shape the pattern does not cover, widen the pattern rather than the docs; record which you did in the report.

- [ ] **Step 2: Verify and commit**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, 328 pass.

```bash
git add tests/docs-drift.test.ts README.md skills/bowser/SKILL.md
git commit -m "test: every registry command appears in README and SKILL.md"
```

---

### Task 5: docs, changelog, full gate, PR

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `openspec/specs/GLOSSARY.md`

- [ ] **Step 1: CLAUDE.md**

Table row `| What command does X? | …` → `| What command does X? | \`src/cli/registry.ts\` (the \`COMMANDS\` list), \`src/commands/<domain>.ts\` (the \`Command\` objects and their implementations) |`. Delete the `src/cli/schemas.ts` mention from that row.

"Adding a command" becomes four steps (the spec's "net effect"):

```markdown
1. Add the op to `DaemonOps` in `src/daemon/protocol.ts` and a handler to the `handlers` table in `src/daemon/server.ts` (tsc fails until both exist); back it with a `Browser` method in `src/browser.ts`. If the op needs CDP, add `requires: "cdp"` to its `DaemonOps` entry and a row to `CDP_OPS` in the same file. A new page script goes in `src/page-scripts.ts`.
2. Add `cmdDblclick` in the `src/commands/<domain>.ts` it belongs to (`interaction.ts` here; use `loadRef` if it takes a ref, `reply` for the answer), and a `Command` entry in that file's `COMMANDS` array with its `summary`, positionals and flags. Dispatch, `--help` and the MCP tool follow automatically.
3. Add a unit test in `tests/commands.test.ts`.
4. Add a row to the README table and the SKILL.md command reference — `tests/docs-drift.test.ts` fails until you do.
```

Delete the old steps 3, 5 and 6 (the `SCHEMAS` entry, the `cli.ts` case, and the `DESCRIPTIONS` line) — the registry makes all three unnecessary. Keep the stdout-purity warning about `src/mcp.ts` by moving its last sentence into step 2's paragraph or into the Gotchas section.

Add a Conventions bullet:

```markdown
- **The registry is the source of truth for what commands exist.** `src/cli/registry.ts` concatenates each `commands/<domain>.ts`'s `COMMANDS`; `SCHEMAS`, `--help` and the MCP tool list are all derived from it, and `tests/docs-drift.test.ts` checks README and SKILL.md against it. A command's `summary` is one line, imperative, no trailing period: it is both its help text and its MCP description.
```

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Changed`, append (filling in the actual help diff observed in Task 2 Step 4):

```markdown
- **Commands are a registry.** Each `src/commands/<domain>.ts` exports `Command` objects; dispatch,
  `bowser --help` and the MCP tool list are generated from them. `src/cli.ts`'s 45-case switch, the
  hand-written help text, and `DESCRIPTIONS`/`MCP_EXCLUDED` in `src/mcp.ts` are gone. Command names,
  argv shapes, exit codes and every command's output are unchanged.
- **`bowser --help` is generated**, so its wording and column alignment changed slightly; every
  command now carries the same one-line summary in `--help` and as its MCP tool description.
  `list` is described as "List sessions" (it enumerates known sessions, including closed ones).
```

- [ ] **Step 3: GLOSSARY**

CLI row: `dispatched in \`src/cli.ts\` (per-command flags in \`src/cli/schemas.ts\`, implementations in \`src/commands/<domain>.ts\`)` → `dispatched in \`src/cli.ts\` from the registry in \`src/cli/registry.ts\`; each command's \`Command\` object and implementation live in \`src/commands/<domain>.ts\``.

- [ ] **Step 4: Full gate, push, PR**

```bash
cd <worktree> && bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
bun build src/cli.ts --compile --outfile dist/bowser
./dist/bowser --help | head -5
BOWSER_BACKEND=webkit ./dist/bowser open https://example.com && ./dist/bowser snapshot && ./dist/bowser close
pgrep -fl "daemon/main|--daemon"
```

Expected: all green; `--help` prints the generated text; the three binary commands return promptly; pgrep shows nothing of ours. Wrap e2e and binary commands in `perl -e 'alarm 900; exec @ARGV or die' --`.

```bash
git add CLAUDE.md CHANGELOG.md openspec/specs/GLOSSARY.md
git commit -m "docs: the registry is where commands are declared"
git push -u origin refactor/5-registry
gh pr create --base main --title "Refactor PR 5: the command registry" --body-file - <<'EOF'
Fifth PR of the maintainability series (spec: docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md, Section 3).

- Each `src/commands/<domain>.ts` exports `Command` objects: name, one-line `summary`, positionals, flags, `mcp?: false`, and a `run` that unpacks its own flags. `src/cli/registry.ts` concatenates them and derives `SCHEMAS`.
- Deleted: the 45-case switch in `cli.ts`, the hand-written `HELP` string, and `DESCRIPTIONS` + `MCP_EXCLUDED` in `mcp.ts`.
- `bowser --help` and the MCP tool list are generated from the same `summary`, so they cannot drift from each other or from the CLI.
- `tests/docs-drift.test.ts` fails if a command is missing from the README table or SKILL.md.
- Adding a command is now: a `Command` entry beside its implementation, a unit test, a README row, a SKILL.md line.

Changed on purpose (spec's contract allows it): the `--help` wording and column alignment, and MCP tool descriptions, both now the same `summary` string. Command names, argv shapes, exit codes and every command's output are unchanged; `tests/compat.test.ts` and `tests/parse-args.test.ts` pass untouched.

Not in this PR: the daemon event lane and `OP_META` (PR 6).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj
EOF
```

---

## Self-review against the spec

- **Section 3 interfaces:** `Positional`, `Command` (with `summary`, `mcp?: false`, `run`), `CommandArgs`, `COMMANDS`, derived `SCHEMAS` — all in Task 1, spelled as the spec writes them.
- **Section 3's four consumers:** dispatch (Task 2), HELP (Task 2), MCP tools (Task 3), docs drift test (Task 4). `mcp` stays a registry entry whose `run` throws today's message, so the `cli.ts` intercept comment stays true (Task 1 + Global Constraints).
- **Section 3's "tests/compat.test.ts and tests/parse-args.test.ts keep importing SCHEMAS and do not change":** honored by re-exporting `SCHEMAS` from `schemas.ts`, and their passing is the proof the derived array matches.
- **Contract:** only `--help` text and MCP descriptions change, both listed in CHANGELOG; command names and argv shapes are pinned by the untouched compat test.
- **Type consistency:** `Command`, `CommandArgs`, `COMMANDS`, `findCommand`, `renderHelp`, `usageOf`, `summary` spelled identically across tasks. Test counts: 316 → 321 (T1) → 326 (T2) → 326 (T3) → 328 (T4).
- **Placeholder scan:** Task 1 Step 2 shows one module's array in full and gives the exact unpacking for every non-trivial `run`; the rest are the same shape over functions that already exist.
