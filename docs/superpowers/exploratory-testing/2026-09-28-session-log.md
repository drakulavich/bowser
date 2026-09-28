# Exploratory-testing session log: Bowser 0.9.x

**Campaign goal:** find the quality risks that 0.8–0.9 introduced and scripted tests miss. The target is the tree at `origin/main` after 0.9.0 and #74.

These areas changed recently:

- **MCP server:** version negotiation, -32600, EPIPE exit, argument checks.
- **Hang recovery:** the reload, `about:blank` on a fresh session.
- **The #63 kick view:** a workaround for oven-sh/bun#44134, where replies over 8 KB stall.
- **Session claim and lifecycle:** F28/F29, `--persistent`, `close --all`.
- **CLI behaviour:** press combos, missing positionals, screenshot limits.

The earlier P1–P3 findings (F1–F42) are fixed. Their specs are in `docs/superpowers/specs/`, and this campaign does not re-report them unless they regress.

**Product context:**
- **Domain:** a CLI, and an MCP server, that AI agents use to drive a real headless WebKit browser.
- **Users:** coding agents (Claude Code and others) that run the `snapshot → ref action → snapshot` loop, often in parallel, often with short timeouts. A few humans use it too.
- **Risks that matter:**
  - a hang that eats the agent's budget;
  - a wrong page state reported as success;
  - a lost session;
  - output that an agent misparses;
  - a password leaking into a snapshot.

**Method:** session-based exploratory testing, following the same rules as `2026-09-06-session-log.md`. Each observation records why the probe was made, the evidence (the exact command, exit code and an output excerpt), and a status. Issues are filed only after the campaign triage.

**Ground rules for every session:**
- Isolated temp `HOME`. Never touch the real `~/.bowser`.
- Kill only processes the session started.
- Local fixtures are served on a random port.
- No network, except in S5.
- Run from the checkout with `bun src/cli.ts`, unless the charter says otherwise.

## Status legend

- `observation`: seen once; may be intentional.
- `candidate`: unexpected, with evidence; needs a contract decision or confirmation.
- `confirmed`: reproducible defect with an agreed expected result.
- `closed`: intentional or duplicate; the rationale is kept.

Severity for `candidate` and `confirmed`:
- **P1:** hang, data loss or leak, wrong success.
- **P2:** wrong or misleading result, with a workaround.
- **P3:** papercut.

## Campaign findings

IDs continue from ET-03.

| ID | Session | Status | Sev | Finding | Evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |

## Charters

| # | Charter | Tours / heuristics | Time box |
| --- | --- | --- | --- |
| S1 | Explore `bowser mcp` as a real stdio MCP client would use it: several sessions, cancellation, a client that disconnects, malformed and oversized traffic. Find where the server breaks the MCP 2025-11-25 contract, blocks, or loses and mixes up responses. | Money, Rained-Out, Saboteur; SFDIPOT Interfaces/Time; oracle Standards (MCP spec), Claims (README) | 60 min |
| S2 | Explore one long-lived session against hostile pages (hangs, never-settling promises, a navigation during an action, timer dialogs, huge DOMs over 8 KB, rapid redirects). Find hangs, stale or wrong state reported as success, and recovery that fails or damages the page. | Bad Neighborhood, Saboteur, Intellectual; SFDIPOT Time/Function; oracle History (P0–P3 fixes), Explainable | 60 min |
| S3 | Explore the session lifecycle under concurrency and interruption (parallel commands, `kill -9` of the daemon mid-op, `close` during an op, `open` twice, `--persistent` across restarts, many sessions, `close --all`). Find lost or duplicated daemons, orphaned state, and wrong exit codes. | Rained-Out, Obsessive-Compulsive, FedEx (one session's life); SFDIPOT Operations/Time; oracle Product, Claims | 60 min |
| S4 | Explore the agent loop exactly as SKILL.md documents it, on realistic forms and SPAs (select, checkbox, date and number, contenteditable, shadow DOM, iframes, `pushState`, password fields). Compare with `playwright-cli` on WebKit. Find output that misleads an agent, ref drift, and documentation that lies. | Guidebook, Landmark, Intellectual; FEW HICCUPPS Comparable/Claims/Users; SFDIPOT Data | 75 min |
| S5 | Explore install and upgrade as a new user and an upgrading user would: install 0.9.0 from npm into a clean directory, run with defaults, upgrade from 0.8.2 while a session is open, unwritable HOME, the Bun version floor. Find first-run failures and version-skew breakage. | Couch Potato, Prior Version, Saboteur; SFDIPOT Operations/Platform; oracle Claims (README install), History | 60 min |

Order: S1 → S2 → S3 → S4 → S5. Each session appends its section below, adds its findings to the campaign table, and ends with a debrief that may reshape later charters.
