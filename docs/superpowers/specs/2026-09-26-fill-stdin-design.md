# Spec: `fill <ref> --stdin` keeps a secret out of argv and output

**Status:** approved (backlog item 4; owner decision 2026-09-26: "so secrets don't leak — I want to use
bowser with my secrets from 1Password").

**Origin:** 2026-09-05 refactor spec, "Backlog notes": "`fill --stdin` so a secret from `op read`
never appears in process arguments."

## Problem

`bowser fill e4 "$(op read op://vault/site/password)"` puts the password in the `argv` of the `bowser`
process, where any local user can read it with `ps` while the command runs. A heredoc or `$(…)` does
not help: the value still ends up in `argv`. Today `fill --json` also echoes the text back
(`{"ok":true,"ref":"e4","text":"<secret>"}`), which lands in an agent's transcript.
`playwright-cli` 0.1.13 has no such flag (`fill <target> <text> [--submit]`); this is a bowser-only
extension and the compatible form stays unchanged.

Intended use: `op read op://vault/site/password | bowser fill e4 --stdin`.

## Behaviour

1. `bowser fill <ref> --stdin` reads all of standard input as UTF-8 and fills it into the ref exactly
   as `fill <ref> <text>` would with that text. The text never appears in `argv`.
2. Exactly one trailing line ending (`\n` or `\r\n`) is removed (`op read` and `echo` end with one);
   everything else is kept verbatim. Empty input fills the empty string.
3. **The text is never echoed** when it came from stdin: the plain answer stays
   `filled <ref> (<role> "<name>")`, and the `--json` answer is `{"ok":true,"ref":"<ref>"}` with no
   `text` key. No error message produced by bowser contains the text. (`fill <ref> <text>` keeps
   today's answers.)
4. Usage errors (exit 1, messages start with `usage:`), all before any daemon request:
   - `--stdin` together with a `<text>` positional;
   - `--stdin` when standard input is a terminal (it would block waiting for typing);
   - neither `<text>` nor `--stdin` (today's error, reworded to mention both forms).
5. Order is otherwise today's: the ref must exist in saved state, the wrong-kind guard, then the live
   resolve and the action. Standard input is read before any daemon request.
6. MCP: the `fill` tool does not offer `stdin` (the text is already a JSON string there and the MCP
   server's own stdin is the JSON-RPC stream). A call passing `stdin` anyway gets a usage error and
   never reads the server's stdin.
7. `--help` for `fill` shows the flag and both forms.

## Acceptance (public seams only)

1. Unit, through `cmdFill` with `fakeClient` and an injected stdin reader (one small injectable
   function in the command context, defaulting to `Bun.stdin` with a TTY check): the typed text equals
   the input minus one trailing newline for multi-line, quotes, `$`, backslashes, `\r\n` and empty
   input; each usage error; no daemon request on a usage error; the plain and `--json` answers do not
   contain the text.
2. CLI: a spawned `bun src/cli.ts fill <ref> --stdin` with piped input, a seeded state in a temp HOME
   and no inherited `BOWSER_BACKEND`: the "`--stdin` plus text" usage error exits 1 without a daemon.
3. E2E on WebKit and Chromium: a secret-looking value piped into `fill <password field> --stdin`
   ends up as the field's value, the command's stdout and stderr (plain and `--json`) do not contain
   it, and while the command runs its `argv` does not contain it (check the spawned process's own
   `cmd`, not `ps`).
4. MCP: the `fill` tool schema has no `stdin` property; `tools/call` with `stdin: true` returns the
   usage error (`tests/mcp.test.ts`).
5. Docs: README and SKILL.md `fill` rows show `--stdin` with the `op read … | bowser fill e4 --stdin`
   example and say the value is not echoed; CHANGELOG under `## [Unreleased]`; docs-drift passes.

## Out of scope

`--submit`; `--stdin` on `type`, `eval`, `run-code`.

**Known gap, closed by the next PR:** `snapshot` prints an `<input type=password>` field's value (as
`playwright-cli` 0.1.13 does), and `state.json` stores up to 120 characters of it, so a secret
filled with `--stdin` still leaks on the next `snapshot`. The owner decided (2026-09-26) that
`snapshot` hides password values and `state.json` does not store them; that ships as its own PR
right after this one.
