# Playwright-CLI Compatibility — Design

**Date:** 2026-04-26
**Status:** Design approved, pending implementation plan
**Target version:** `@drakulavich/bowser-cli@0.2.0`

## Goal

Make `bowser` a drop-in command-compatible replacement for Microsoft's [`playwright-cli`](https://github.com/microsoft/playwright-cli) for the **core agent loop**. An agent currently scripted against `playwright-cli` should run unchanged after replacing the binary name.

Non-goal in v1: parity for storage, network, tracing, devtools, tabs, mouse-level control. Those remain on the roadmap.

## Approach

**Clean break.** Bowser's existing 0.1.0 surface is replaced, not aliased. Existing `snap`, `-i`, and `@eN` ref prefix go away. `--session` is retained as a long-form alias for `-s` (per design decision). Version bumps to `0.2.0`; CHANGELOG documents the migration.

The engine (daemon, snapshot walker, ref resolution, session state) is reused. Only the CLI layer and snapshot output formatter change, plus a few small daemon ops.

## Command surface (v1)

| Command | Args | Notes |
|---|---|---|
| `install` | `[--force]` | download Chromium into `~/.bowser/chromium` |
| `open` | `[url]` | start session; navigate if URL given |
| `goto` | `<url>` | navigate within current session |
| `close` | – | end session, release daemon, clear state |
| `snapshot` | `[--filename=f] [--depth=N]` | aria-tree YAML; `--depth` parsed but ignored in v1 |
| `click` | `<ref>` | |
| `fill` | `<ref> <text>` | clears then types |
| `type` | `<text>` | types into focused element |
| `press` | `<key>` | e.g. `Enter`, `Tab`, `ArrowDown` |
| `hover` | `<ref>` | |
| `select` | `<ref> <value>` | `<select>` element only |
| `check` | `<ref>` | |
| `uncheck` | `<ref>` | |
| `screenshot` | `[ref] [--filename=f]` | full-page if ref omitted |
| `go-back` | – | |
| `go-forward` | – | |
| `reload` | – | |
| `list` | – | enumerate sessions |

**Removed from 0.1.0:** `snap` (→ `snapshot`), `session show`/`session list` (→ `list`), `-i` flag, `@e` ref prefix.

## Flag syntax

Match `playwright-cli`:

- Session: `-s=name`, `-s name`, `--session=name`, `--session name` (all four accepted).
- Named flags: `--filename=path` is canonical; `--filename path` also accepted.
- Help: `-h` / `--help` per command.
- Refs: bare `eN` (no `@`).
- Bowser-only: global `--json` toggles structured output for snapshot/list and `{"ok":true,...}` envelopes for action commands.

Exit codes: `0` success, `1` user error (bad ref, missing arg, unknown command), `2` runtime error (timeout, daemon crash).

A new `src/cli/parser.ts` replaces the hand-rolled `parseArgs`. Parser is generic over a per-command schema so each subcommand declares its flags/positionals — single source of truth for parsing and `--help`.

## Snapshot output

Byte-compatible aria-tree YAML matching `playwright-cli snapshot`. No `url:`/`title:` header (those stay internal in `state.json`).

```yaml
- generic:
  - link "More information...": [ref=e1] /url
  - button "Submit": [ref=e2]
  - textbox "Email": [ref=e3] "current@x.com"
```

Rules:

- One ref per line, format `- <role> "<name>": [ref=eN]`.
- Inputs append current value if non-empty: `[ref=e3] "value"`.
- Links append href: `[ref=e1] /url`.
- Flat list in v1 (no nesting). `--depth` is parsed for compatibility, ignored.
- `--filename=path` writes to disk and prints `wrote <path>`. Otherwise YAML to stdout.

`--json` shape:

```json
{
  "url": "https://...",
  "title": "...",
  "refs": [
    { "ref": "e1", "role": "link", "name": "...", "selector": "...", "href": "/url" }
  ]
}
```

Refs persist in `~/.bowser/sessions/<name>/state.json` keyed without `@`.

## Daemon ops

Existing: `navigate, click, type, evaluate, state, shutdown`. Add:

| Op | Implementation |
|---|---|
| `press(key)` | CDP `Input.dispatchKeyEvent` |
| `hover(selector)` | CDP `Input.dispatchMouseEvent move` |
| `select(selector, value)` | evaluate shim: set `el.value = v` + dispatch `change` |
| `check(selector)` / `uncheck` | evaluate shim: set `el.checked` + dispatch `change` |
| `screenshot(selector?, path?)` | CDP `Page.captureScreenshot`; element bounds via `getBoundingClientRect` when ref given |
| `back` / `forward` | CDP `Page.navigateToHistoryEntry` |
| `reload` | CDP `Page.reload` |

`src/snapshot.ts` updated: refs as `eN`, output formatter emits aria-tree YAML. DOM walk unchanged. Selector resolution (`resolveRef`) unchanged.

## Skill (`skills/bowser/SKILL.md`)

Mirrors the structure of Playwright's agent-skill so a current `playwright-cli` skill consumer can swap.

- Frontmatter description rewritten: "drop-in command-compatible alternative to Microsoft `playwright-cli`".
- Top-of-file drop-in note: replace `playwright` with `bowser`; output and ref naming are compatible.
- Command reference table reuses Section 1 verbatim with `-s=name` examples.
- Snapshot section shows aria-tree YAML, refs as `eN`.
- Worked example (login → extract) rewritten to new syntax.
- Existing agent-rules retained (snap-before-act, role-over-name, untrusted-content).

## Migration & breakage

- Ship as `0.2.0` (pre-1.0; breakage expected).
- CHANGELOG entry: "Breaking — bowser is now command-compatible with Microsoft `playwright-cli`. Migration table included."
- README rewrite: lead with drop-in claim, new command table, migration section.
- No shim layer. Old syntax errors with a hint pointing at the migration section.

## Testing

- **`tests/parse-args.test.ts`** — rewritten for new parser. Per-command cases: all four session forms, equals/space flag forms, missing positionals, unknown flags, `--help`.
- **`tests/commands.test.ts`** — one block per command using the existing fake-daemon harness. Asserts: parsing, daemon op + args, stdout shape, `--json` shape, exit codes.
- **`tests/snapshot.test.ts`** — golden tests for the aria-tree YAML emitter and parallel `--json` golden.
- **`tests/e2e*.test.ts`** — updated to new commands. The todo-app e2e becomes a drop-in proof: run the same flow with `playwright-cli` (when present in `$PATH`) and `bowser` against the same server, diff snapshots. Skips cleanly when `playwright-cli` is absent.
- **`tests/compat.test.ts`** (new) — table-driven test of `playwright-cli` invocation strings parsing without error. Insurance against drift.

CI: `bun test` runs unit + command tests on every push; nightly `BOWSER_E2E=1` job runs against bundled Chromium; the playwright-cli diff job runs only when the external binary is available.

## Out of scope (v2+)

- Snapshot nesting (`--depth` honored)
- Storage commands (`cookie-*`, `localstorage-*`, `state-save/load`)
- Tab management
- Network mocking (`route`, `unroute`)
- Tracing, video, PDF
- `eval`, `run-code`, `dialog-accept/dismiss`, `resize`, mouse-level control
- MCP bridge subcommand
