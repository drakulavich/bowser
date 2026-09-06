# Exploratory-testing session log — Bowser

**Campaign goal:** discover quality risks that scripted tests miss in Bowser's
agent-facing CLI and long-lived browser sessions.

**Method:** session-based exploratory testing. Each observation records the
reason for the probe, its evidence, and a provisional status. A ticket is
created only after campaign-level triage confirms reproducibility, severity,
and scope.

## Status legend

- `observation` — behaviour seen once; may be intentional.
- `candidate` — unexpected behaviour with evidence; needs a contract decision
  or confirmation.
- `confirmed` — reproducible defect with an agreed expected result.
- `closed` — intentional behaviour or duplicate; retain rationale.

## Session 1 — first launch and distribution

**Charter:** Explore a clean, compiled distribution to discover startup,
backend-selection, and daemon-lifecycle failures.

**Time box:** 60 min  
**Heuristics:** SFDIPOT (Operations, Platform, Time); Guidebook and
Rained-Out tours.  
**Environment:** macOS; Bun 1.4.0; isolated temporary `HOME`; a binary
compiled from the current checkout.

### Notes

- Compiled the binary in 205 ms; `--help` exited 0 within a 20-second guard.
- `BOWSER_BACKEND=firefox` exited 1 with the documented actionable error.
- With a fresh `HOME`, `open → snapshot → close` succeeded across separate
  binary invocations; the snapshot exposed the expected `button "Continue"`
  ref.
- Explicit `BOWSER_BACKEND=webkit` also completed `open → snapshot → close`
  with exit code 0.
- After close, no test daemon process or Unix socket remained.

### Findings

| ID | Status | Finding | Evidence | Next action |
| --- | --- | --- | --- | --- |
| ET-01 | candidate | `list` retains names of closed sessions, although no daemon or socket remains. | Closed state files have `url: ""` and no refs; `cmdList` enumerates session directories. README calls the command “List sessions”. | Triage as a documentation/UX ambiguity: decide whether `list` means known or active sessions. |

**Debrief:** no confirmed functional defect. Temporary binaries and runtime
state were moved to the local Trash after evidence collection; the repository
was clean.

## Session 2 — dynamic agent loop

**Charter:** Explore `snapshot → ref action → snapshot` against a dynamic,
client-rendered local page to discover stale refs, lost actions, or state that
does not survive independent CLI invocations.

**Time box:** 60 min  
**Heuristics:** SFDIPOT (Function, Structure, Time); Business District and
Intellectual tours.  
**Status:** complete.

### Live notes

- Starting with an isolated temporary `HOME` and a dynamic local data page;
  record a before/after snapshot for every action that changes the DOM.
- Compiled a temporary binary and started `tests/fixtures/todo-app.html` on
  `http://localhost:41987/`; no external service or user session is involved.
- **Observation:** initial snapshot returned exactly the form textbox (`e1`),
  Add button (`e2`), and Clear completed button (`e3`), with stable ID-based
  selectors. Proceeding to DOM mutation rather than treating this happy path
  as sufficient evidence.
- **Candidate ET-02 (unconfirmed):** `fill e1 "alpha 🚀"` timed out in its
  initial click after the configured 5 seconds. A following snapshot reported
  only an empty generic page and persisted `about:blank`. The fixture server
  was still reachable and served `Bowser Todo` when checked independently.
  Stop the charter's functional exploration here; reproduce with a clean
  session and distinguish a compiled-binary, WebKit, or test-harness fault.
- **Reproduction update:** a clean session passed `fill e1 a`, but its next
  `fill e1 "alpha 🚀"` hit the same click timeout. A third clean session
  completed two immediate ASCII fills and retained `second` in the DOM. ET-02
  is therefore timing- or multi-daemon-sensitive, not yet a confirmed defect;
  Unicode is not established as a cause.
- **Control:** the isolated project e2e todo test passed (1 test, 11
  assertions) on WebKit after the test sessions were closed.
- **Observation:** a final single-session run added `alpha`, toggled it, and
  cleared it. The post-clear snapshot contained no `Toggle alpha` ref, so no
  incorrect action occurred.
- **Candidate ET-03 (contract decision needed):** using the checkbox ref
  obtained before clear *without a new snapshot* waited the full configured
  8 seconds, then returned `operation 'click' timed out`. This is safe (no
  wrong target was clicked), but can be poor agent-loop latency. Decide in
  triage whether an explicitly stale ref should fail faster or whether
  actionability waiting is the intended compatibility contract.

### Debrief

- No confirmed defect in the dynamic agent loop.
- ET-02 remains an unconfirmed flake for the later session-isolation charter:
  investigate timing and concurrent WebKit daemons before filing.
- ET-03 is a product/compatibility question, not a ticket until an expected
  stale-ref contract is agreed.
- Next session should focus on named-session isolation and daemon recovery,
  where ET-02's suspected condition can be tested directly.

## Session 3 — named-session isolation and daemon recovery

**Charter:** Explore two concurrent named WebKit sessions to discover shared
browser data, cross-session DOM actions, lost state after one daemon exits, or
the timeout pattern observed in ET-02.

**Time box:** 60 min  
**Heuristics:** SFDIPOT (Data, Structure, Operations, Time); FedEx and
Bad-Neighborhood tours.  
**Status:** complete.

### Live notes

- Use a single local todo origin and a shared, otherwise empty temporary
  `HOME`. Each named session has its own daemon; set distinct localStorage
  values and mutate only one session's todo list before comparing snapshots.
- **Observation:** both sessions opened and snapshotted successfully. On the
  same origin, `session-a` read `owner=A` and `session-b` read `owner=B` after
  each wrote its own localStorage value; no shared browser-data leak observed.
- **Confirmed ET-02:** with two live WebKit daemons on the local todo page, a
  ref action in one session timed out after 8 seconds. In one run the initial
  click inside `fill` timed out; in a fresh C/D run, `fill e1 probe` succeeded
  but the following `click e2` timed out. Both sessions then snapshotted as
  only `- generic`, persisted `about:blank`, and rejected localStorage as
  insecure. The local HTTP server remained healthy throughout.
- **Control:** the same flow passes in a single WebKit session and in the
  existing isolated WebKit e2e todo test. The defect therefore needs a
  multi-session WebKit / daemon-isolation investigation; its root cause is
  not yet known.

### Debrief

- Named sessions isolate localStorage before interaction, so ET-02 is not a
  simple shared-data leak.
- ET-02 is a confirmed, high-impact candidate for a ticket: a normal action
  in one named session can blank both active browser pages.
- Do not infer a code fix yet. A follow-up must compare source versus compiled
  binary and Chrome versus WebKit, then localize WebView process ownership.

## Session 4 — ET-02 platform contrast

**Charter:** Re-run the minimal two-session interaction using the source CLI
and Chrome backend to discover whether ET-02 is tied to compilation, daemon
transport, or WebKit's process model.

**Time box:** 60 min  
**Heuristics:** SFDIPOT (Platform, Interfaces, Time); Bad-Neighborhood and
Rained-Out tours.  
**Status:** complete.

### Live notes

- Use the same local todo page and a fresh temporary `HOME` per variant.
- Chromium headless-shell is available locally; Chrome can be tested without
  downloading anything or touching existing user browser data.
- **Source WebKit result:** `open`, `snapshot`, `fill`, and `click` returned
  success for two source-launched sessions, but the next snapshot of both
  sessions was only `- generic`. ET-02 is therefore not a compiled-binary
  regression; a successful action result is also insufficient evidence that
  a multi-session WebKit page remains alive.
- **Chrome control:** with the same compiled binary, two Chrome sessions
  completed `fill → click → snapshot`; session A retained `Toggle
  chrome-probe` and session B remained unchanged. ET-02 is therefore scoped
  to the WebKit backend in the tested environment.
- **Code-path evidence:** every daemon creates its own `Bun.WebView` through
  `startDaemon → openBrowser`; serialization protects only a single daemon's
  view. This is an investigation boundary, not a root-cause claim.

### Debrief

- ET-02 reproduces on source and compiled WebKit, and does not reproduce on
  Chrome. It is ready for a high-priority backend-scoped ticket after the
  campaign triage.
- A fix investigation should first establish whether concurrent native
  WebKit views are supported by the installed Bun runtime, then choose between
  global WebKit serialization, a single WebKit owner process, or an explicit
  capability restriction for multiple sessions.
