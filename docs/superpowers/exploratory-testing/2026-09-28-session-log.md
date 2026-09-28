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
| ET-04 | S1 | confirmed | P1 | Non-ASCII text over ~8 KB is corrupted with U+FFFD in both directions of the daemon socket (each chunk is decoded on its own: `src/daemon/client.ts:65`, `src/daemon/server.ts:405`). Snapshots, eval results and long `fill`/`eval` inputs come back or go in wrong, as success. CLI and MCP alike. | S1 notes "UTF-8 split": `eval "'é😀'.repeat(2000)"` → 3 U+FFFD at index 4081; snapshot of 777 multilingual buttons → 2 U+FFFD; repeatable | Decode the socket stream with one streaming `TextDecoder` (or split bytes on `\n` first); add a test with a codepoint across a chunk boundary |
| ET-05 | S1 | candidate | P3 | An unknown tool (`nope`, no `params`, `name: 5`) is answered as a tool result with `isError: true`. MCP 2025-11-25 lists unknown tools as a protocol error (`-32602`). | S1 notes, p1-protocol.ts, 2 runs | Contract decision: `-32602 Unknown tool` or keep and document |
| ET-06 | S1 | candidate | P3 | A message with an id and no method (or a non-string method) gets `-32601 Method not found: undefined` instead of `-32600`; a client *response* (`{"id":33,"result":{}}`) is answered with that error, which JSON-RPC forbids. | S1 notes, p1-protocol.ts, 2 runs | Answer `-32600` for a bad method; send nothing for a message with `result`/`error` |
| ET-07 | S1 | candidate | P3 | `eval` of a promise that never settles fails after 2.5 s with WebKit's `Completion handler for function call is no longer reachable`, which does not tell the agent what happened. | S1 notes, p10-hang.ts, 2 runs | S2 to confirm on its hostile pages; then decide on a clearer message |
| ET-08 | S1 | observation | — | No MCP lifecycle checks: `tools/list`, `ping` and `tools/call` answer before `initialize`, and a second `initialize` switches the reported protocol version. The spec leaves the server free here. | S1 notes, p1-protocol.ts | Close unless a client is seen to depend on it |

## Charters

| # | Charter | Tours / heuristics | Time box |
| --- | --- | --- | --- |
| S1 | Explore `bowser mcp` as a real stdio MCP client would use it: several sessions, cancellation, a client that disconnects, malformed and oversized traffic. Find where the server breaks the MCP 2025-11-25 contract, blocks, or loses and mixes up responses. | Money, Rained-Out, Saboteur; SFDIPOT Interfaces/Time; oracle Standards (MCP spec), Claims (README) | 60 min |
| S2 | Explore one long-lived session against hostile pages (hangs, never-settling promises, a navigation during an action, timer dialogs, huge DOMs over 8 KB, including non-ASCII ones (ET-04), rapid redirects), and confirm ET-07. Find hangs, stale or wrong state reported as success, and recovery that fails or damages the page. | Bad Neighborhood, Saboteur, Intellectual; SFDIPOT Time/Function; oracle History (P0–P3 fixes), Explainable | 60 min |
| S3 | Explore the session lifecycle under concurrency and interruption (parallel commands, `kill -9` of the daemon mid-op, `close` during an op, `open` twice, `--persistent` across restarts, many sessions, `close --all`, two MCP servers or an MCP server plus the CLI on one session). Find lost or duplicated daemons, orphaned state, and wrong exit codes. | Rained-Out, Obsessive-Compulsive, FedEx (one session's life); SFDIPOT Operations/Time; oracle Product, Claims | 60 min |
| S4 | Explore the agent loop exactly as SKILL.md documents it, on realistic forms and SPAs (select, checkbox, date and number, contenteditable, shadow DOM, iframes, `pushState`, password fields, long non-ASCII `fill` text and non-English forms, after ET-04). Compare with `playwright-cli` on WebKit. Find output that misleads an agent, ref drift, and documentation that lies. | Guidebook, Landmark, Intellectual; FEW HICCUPPS Comparable/Claims/Users; SFDIPOT Data | 75 min |
| S5 | Explore install and upgrade as a new user and an upgrading user would: install 0.9.0 from npm into a clean directory, run with defaults, upgrade from 0.8.2 while a session is open, unwritable HOME, the Bun version floor. Find first-run failures and version-skew breakage. | Couch Potato, Prior Version, Saboteur; SFDIPOT Operations/Platform; oracle Claims (README install), History | 60 min |

Order: S1 → S2 → S3 → S4 → S5. Each session appends its section below, adds its findings to the campaign table, and ends with a debrief that may reshape later charters.

## S1 — `bowser mcp` as a real stdio client
**Charter:** S1 (see Charters).   **Time box:** 60 min.   **Tours/heuristics:** Money, Rained-Out, Saboteur; SFDIPOT Interfaces/Time; oracles Standards (MCP 2025-11-25, JSON-RPC 2.0), Claims (README "MCP bridge").   **Environment:** macOS 27, Bun 1.4.2, bowser 0.9.0 at 82eb268, run as `bun src/cli.ts mcp` with a temp HOME.

Client: `scratchpad/s1/lib.ts` (Bun, spawns the server, 20 s per-request deadline, `alarm` per script, kills only daemons whose pid file is under its own HOME). Scripts `p*.ts`, outputs `p*.out` beside it.

### Live notes
- Protocol edges with no browser (p1-protocol.ts, exit 0, 10.6 s). Every line below reproduced in two runs.
  - Before `initialize`: `tools/list`, `ping` and an unknown `tools/call` are all answered normally. No lifecycle check. (observation)
  - A second `initialize` with `2024-11-05` is answered and switches the reported version mid-session. (observation)
  - Malformed JSON → -32700 id null; `[...]`, `[]`, `42` → one -32600 id null. Matches README.
  - `{"id":11}` (no method) and `{"id":12,"method":5}` → `-32601 Method not found: undefined` / `: 5`. JSON-RPC says -32600 Invalid Request. (candidate P3)
  - A client *response* `{"id":33,"result":{}}` gets an error reply `-32601 Method not found: undefined`. JSON-RPC: a response must not be answered. Harmless today (the server never sends requests), but a strict client may log it as a protocol error. (candidate P3, same root as above)
  - Unknown tool (`nope`, missing `params`, `name: 5`, `mcp`) → `result.isError: true` "unknown tool: …". MCP 2025-11-25 (server/tools, Error Handling) lists unknown tools as a protocol error, example `-32602 Unknown tool`. (candidate P3)
  - `jsonrpc` missing or `"1.0"`, id object / bool / 1.5 → answered as if valid. (observation, lenient)
  - `id: null` request, unknown notifications, `notifications/cancelled` for an unknown id or with no params → silence, no crash.
  - CRLF, two messages in one write, one message split over two writes, blank lines → all handled.
  - Wrong argument types, unknown keys, `__proto__` key, `session: "../../evil"` → `usage:` isError, nothing runs. Matches README (F42 holds).
  - stdout had 37 lines, all JSON-RPC; stderr empty; stdin close → exit 0 at once.
  - Rerun of p1 matched line for line. Two reruns were interrupted by the host sleeping (a 1.5 s wait took 305 s and 1050 s by wall clock; the laptop suspended). Environment, not bowser; later probes kept short.
- Real sessions (p2-sessions.ts, exit 0, 4.5 s; local fixture server on port 0).
  - Parallel `open` on `sa` and `sb`: both answered in 966 ms.
  - Same session `sa`: slow `goto` (3 s), `snapshot`, `eval` queued behind it; plus `ping` and an `eval` on `sb`. Arrival order `p1,e2,g1,s1,e1`: ping and the other session were not blocked, and `sa` kept its order (snapshot and eval saw the slow page). Matches README.
  - Snapshot of 400 list items: 60 685 chars in 39 ms; 3 000 items: 469 685 chars in 261 ms, complete (tail ref e9003). No 8 KB stall (#63 holds over MCP).
  - `screenshot` with no filename writes `<cwd>/screenshot-sa.png`; absolute filename used as given (455 KB file). Reply is a path, not image content.
  - `snapshot` reply is pretty-printed JSON (`{\n  "snapshot": …}`), while every other tool answers compact JSON. (observation)
  - stdout noise: none; stderr: empty.
- Cancellation and stdin close (p3-cancel.ts, exit 0, 15 s).
  - Cancel a queued `goto`: no reply, and the fixture server never saw its URL. Cancel a running `goto`: no reply; the next `eval` on the session waited for it (2 s) and saw its page. Both as README says.
  - `requestId: "7"` does not cancel the call with id `7`: ids are compared by type. Correct per JSON-RPC. (observation)
  - The same id in flight on two sessions, then cancelled: only the later call is dropped; the earlier answers. Client misuse, no crash. (observation)
  - Cancel of an already answered id: ignored; ping still answers.
  - stdin closed with one call running and two queued (one on another session): all three answered, then exit 0 after 1.8 s. Matches README.
- Client gone or slow (p4-disconnect.ts, exit 0, 12 s).
  - stdout piped to `head -n 2`; after head exits, a running slow `goto` (G1) and a queued `goto` (G2) are sent. Server exits 0 three seconds later with empty stderr; the fixture saw G1 and never G2. Matches README (F41 holds).
  - Client does not read stdout for 8 s while two 470 KB snapshots, a `ping` and an `eval` on another session are answered. When reading resumes, all 7 replies arrive whole and in write order (`init,o2,o,snap,snap2,ping,eg`). The ping waited behind the unread snapshots: "answered at once" holds only while the client drains stdout. (observation)
  - After the server exits, its daemons keep running until killed (by design; see S3).
- Errors and races (p5-errors.ts, exit 0, 2 s). Failures come back as `isError` text; stdout stayed pure JSON-RPC with `BOWSER_DAEMON_DEBUG=1`.
  - `snapshot` on a never-opened session spawns a daemon and answers `{"snapshot": ""}` as success. (observation; the agent gets no hint that the session is new)
  - `close {all: true}` while session `k` runs a slow `goto`: close answers `closed: [never-opened, h, k]`; the `goto` answers `isError: daemon for session 'k' closed the connection`. Then `eval` on `k` quietly starts a fresh daemon (title `""`), and `list` shows `k` again. Clear enough. (observation)
  - `eval "'é😀'.repeat(50000)"` came back with U+FFFD in it. Followed up below.
- UTF-8 split at socket chunk boundaries (p6-utf8.ts, p7-utf8-snap.ts, p8-snapsizes.ts; each run twice, same numbers).
  - `eval` of `'é😀'.repeat(n)`: n=10 intact; n=2000 (6 000 chars) → 6 001 chars with 3 U+FFFD, first at index 4081; n=50000 → 36 U+FFFD. Pure `😀` or pure Cyrillic come back intact (their byte widths happen to line up with the chunk size).
  - The CLI has the same bug: `bun src/cli.ts --session u --json eval "'é😀'.repeat(2000)"` exit 0, 3 U+FFFD. So it is below MCP.
  - Snapshot of a page of buttons with Russian, French, German and Japanese labels: intact up to 500 items (33 KB), then 2 U+FFFD at 777 items (52 KB, twice), 1 000 and 1 500 items. `eval document.body.innerText` corrupted at 1 500 items. The agent gets a wrong accessible name, reported as success.
  - Request direction too: `eval` of a 6 000-char `é😀` literal compared with itself answers `false`; the literal the page received contains U+FFFD.
  - Cause (reading, not a fix): `src/daemon/client.ts:65` `self.buf += data.toString()` and `src/daemon/server.ts:405` `… + data.toString()` decode each socket chunk on its own, so a codepoint split across two chunks becomes U+FFFD. The writer side is byte-safe (`tests/socket-write.test.ts:32`), the readers are not.
- Many sessions at once (p9-mix.ts, run twice, exit 0, 2–3 s): 5 sessions × 6 calls (eval, slow goto, eval) sent in one burst. All 30 answered once, each with its own session's result, each session in send order. No mix-up, no duplicate, no noise.
- Never-settling eval (p10-hang.ts, run twice): `eval "new Promise(() => {})"` fails after 2.5 s with `isError: Completion handler for function call is no longer reachable`; the queued `eval` then answers, ping was answered at once, and stdin close exits 0. The failure is right; the message is WebKit's internal one and does not tell the agent its promise never settled. (candidate P3, more for S2)

### Debrief
- **Learned.** The MCP layer itself held up: ordering per session, concurrency across sessions, cancellation, EPIPE exit, stdin close, argument checks and stdout purity all match the README, under bursts and 470 KB replies. The one serious defect sits below it: the daemon socket readers decode each chunk separately, so non-ASCII text over roughly 8 KB comes back (and goes in) with U+FFFD, reported as success. It hits the CLI too. The protocol gaps are small: unknown tool as a tool result, -32601 for a request with no method, and a reply to a client's response.
- **Coverage.** Interfaces (stdio framing, JSON-RPC, MCP lifecycle, tools/call arguments, daemon socket), Time (queues, cancellation, slow calls, stalled reader, disconnect), Data (8 KB+ replies, multibyte text), Operations (stdin close, EPIPE, close --all mid-call). Not covered: two MCP servers sharing one session, `state-save`/`state-load` over MCP, the 2025-06-18 and 2024-11-05 clients beyond `initialize`.
- **Time.** About 60 min of work: setup 20 %, explore 55 %, investigate 25 %. Two runs were lost to host sleep.
- **For later charters.** S2: add non-ASCII pages over 8 KB (snapshot, `eval innerText`) to the huge-DOM probes, and look at the never-settling-eval message. S4: `fill` with long non-ASCII text (the request direction corrupts too) and snapshots of non-English forms. S3: two MCP servers, or MCP plus CLI, on one session.

**Triage note (orchestrator, after S1):** I reproduced ET-04 independently: `eval "'é😀'.repeat(2000)"` → 3 U+FFFD, and the cause is `data.toString()` per socket chunk in `src/daemon/client.ts:65` and `src/daemon/server.ts:405`. Status: confirmed. S2–S4 charters were extended per the S1 debrief.
