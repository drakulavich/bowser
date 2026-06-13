# bowser — Baseline Specifications

This directory is the **baseline spec corpus**: it captures how bowser *actually
behaves today*, one capability per directory, so future work can be proposed as
OpenSpec change deltas against a trustworthy reference instead of tribal knowledge.

> **Disclaimer (living document).** These specs describe the current release and
> are updated whenever behavior changes. If a spec and the code disagree, the code
> is the bug *or* the spec is stale — either way, open an issue; don't silently
> trust one side.

> **Status.** The corpus is being established. Capabilities are extracted into
> `specs/<name>/spec.md` as they are written; the table below lists the planned
> set and links each one once its spec lands. Until then, `README.md`,
> `skills/bowser/SKILL.md`, and `docs/superpowers/specs/` are the closest record.

## How to read these specs

Every spec follows the same shape:

- **Purpose** — what the capability does and for whom.
- **Non-Goals** — what it deliberately does *not* do (so nobody "fixes" that).
- **Requirements** — verifiable contracts (`SHALL`), each with at least one
  happy-path and one error/edge **Scenario** in Given/When/Then form.
- **Technical Notes** — constants, tables, and `file:line` traceability refs,
  kept out of the requirement text so contracts stay readable.
- **Open Issues** — known gaps, tracked by GitHub issue where one exists.

Terminology is canonical: every term of art (Session, Daemon, Ref, Snapshot,
Backend, …) is defined once in [GLOSSARY.md](GLOSSARY.md) and used verbatim
everywhere else.

## Personas

Specs reference these named personas instead of a generic "user":

- **Sora, the agent author** — drives bowser from an LLM agent's shell loop, often
  through `skills/bowser/SKILL.md`, treating it as a drop-in `playwright-cli`. Cares
  about a stable command surface, byte-for-byte snapshot YAML, `--json` output, and
  exit codes.
- **Ravi, the skill maintainer** — keeps bowser command-compatible with
  `playwright-cli` so existing playwright skills work unchanged. Cares about the
  compat invocation table (`tests/compat.test.ts`) and the snapshot golden
  (`tests/snapshot.test.ts`).
- **Dana, the contributor** — adds commands and backends. Cares about the Daemon
  protocol, ref resolution, TDD discipline, and the Bun-native (no npm runtime deps)
  constraint.

## Capabilities

| Spec | Covers |
|---|---|
| sessions | Named persistent sessions, the per-session Daemon, `--session`, `list`, `close` |
| navigation | `open`, `goto`, `go-back`, `go-forward`, `reload` |
| snapshot | aria-tree YAML of interactive Refs, `--depth`, `--json` shape |
| interaction | `click`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `screenshot` |
| storage | `localstorage-*` and `sessionstorage-*` read/write/clear |
| cookies | `cookie-*` over CDP (HttpOnly first-class; chrome backend) |
| scripting | `eval`, `run-code` |
| install-and-backends | `install`, backend selection (WebKit vs Chrome/CDP), Bun requirement |

*(Links are added as each `spec.md` is written; rows without a link are not yet
extracted — see Status above.)*

## Validation

These commands require the standalone **OpenSpec CLI** — a global developer tool
installed separately, **not** a bowser dependency (bowser ships no runtime deps).
The specs themselves are plain Markdown and reviewable without it.

```bash
openspec spec list                    # enumerate capabilities
openspec validate --specs --strict    # structural validation — must exit 0
```
