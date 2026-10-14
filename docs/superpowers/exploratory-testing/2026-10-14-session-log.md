# Exploratory-testing session log: Bowser 0.12 before release

**Campaign goal:** find the quality risks in what `main` has added since 0.11.0 and no scripted test covers. The target is `main` at 73181c8. These areas are new:

- **Restart after an upgrade (#145, PR #149):** the first command after `npm i -g` stops a daemon that an older version started, opens the page again with the same profile and prints one line about what was lost. A lock in the session dir keeps parallel first commands from restarting twice.
- **MCP handover (#145, PR #149):** a running `bowser mcp` that finds itself older than the installed files waits for its calls to finish, spawns the new server, replays `initialize` and forwards everything to it.
- **`markdown` (#130–#140):** prints the page or one ref's element as Markdown, takes a site's own `text/markdown` alternate when it answers in time, and falls back to converting the DOM.

**Product context:**
- **Domain:** a CLI and MCP server that AI agents use to drive headless WebKit.
- **Users:** coding agents running the `snapshot → ref action → snapshot` loop, often in parallel, often with short timeouts; their humans run `npm i -g` without stopping anything first.
- **Risks that matter:** a hang that eats the agent's budget, a lost session or login, a report that says something other than what happened, output an agent misparses, a password in the output.

**Method:** session-based exploratory testing, as in `2026-09-28-session-log.md`. Each observation records why the probe was made, the evidence (command, exit code, output excerpt) and a status. Issues are filed after the campaign triage. Scripts, fixtures and installs live in each session's scratch directory and are not in the repo.

**Ground rules for every session:**
- Isolated temp `HOME` and npm prefix. The real `~/.bowser` and the global install are never touched.
- Kill only processes the session started.
- Local fixtures are served on a random port.
- No network, except in S3 and the npm registry in S1.

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

IDs continue from ET-28.

| ID | Session | Status | Sev | Finding | Evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |

## Charters

| # | Charter | Tours / heuristics | Time box |
| --- | --- | --- | --- |
| S1 | Explore the upgrade from 0.11.0 (npm) to `main` packed as 0.12.0, installed into a temp prefix, with ephemeral, `--persistent` and `--profile` sessions open, to discover a lost login, a double restart, a wrong or missing notice, and a hang when the first commands after the upgrade run in parallel, under a short budget, or are killed mid-restart. | Prior Version, Rained-Out, Obsessive-Compulsive; SFDIPOT Operations/Time; oracles Claims (README "Upgrading", CHANGELOG), History (ET-18, ET-25, ET-26) | 60 min |
| S2 | Explore a running `bowser mcp` across an in-place upgrade (two local packs, 0.12.0 then 0.12.1) with calls in flight, queued and cancelled, a client that closes stdin mid-handover, and a new install that cannot start, to discover lost or duplicated replies, a server that never answers again, and stdout that stops being pure JSON-RPC. | Rained-Out, Saboteur, FedEx (one request id through the handover); SFDIPOT Interfaces/Time; oracles Standards (MCP 2025-11-25, JSON-RPC 2.0), Claims | 60 min |
| S3 | Explore `markdown` on real sites an agent reads (docs that serve `.md`, Wikipedia, GitHub, news, a client-rendered SPA, a consent wall, pages over 1 MB) and compare with the site's own Markdown and with what `snapshot` shows, to discover dropped or invented content, links that break, a hang, and output too large or too noisy for an agent. | Money, Intellectual, Bad Neighborhood (#135–#140); FEW HICCUPPS Comparable/Purpose/Users; SFDIPOT Data | 75 min |
| S4 | Explore the session lifecycle on 0.12 with its dependencies taken away (an install path with a space (#150), a session dir deleted or made unwritable, a daemon killed mid-op, a full disk simulated by a read-only HOME, `close --all` right after a restart) to discover orphaned daemons, sessions that cannot recover, and messages that send the agent the wrong way. | Saboteur, Rained-Out, Garbage Collector (every error message the lifecycle can print); SFDIPOT Operations/Platform; oracles Explainable, Product | 60 min |

Order: S1 → S2 → S3 → S4. Each session appends its section below, adds its findings to the campaign table and ends with a debrief that may reshape the later charters.
