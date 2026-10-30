# click waits in bowser and clicks by coordinates (#267)

Issue: #267. Touches the same native click as the #111 spec (PR #268).
Status: draft, waiting for review.

## Goal

When the page navigates while `click` waits for its target, the command fails within its budget with a message that names the navigation, exit 2. Nothing is clicked on the new page, and the next command works without `bowser close`.

## What happens today

`Browser.click` calls Bun's `view.click(selector, { timeout })` (`src/browser.ts:802`). Bun waits page side, once per animation frame, until the element exists, has a non-zero box with its centre in the viewport, keeps the same box for two frames, and is the hit target at the centre (`kActionabilityJS` in `WebViewHost.cpp`, [oven-sh/bun@f7607a3](https://github.com/oven-sh/bun/blob/f7607a3d350b9c9488d41eab6a18d6cac74794e6/src/runtime/webview/WebViewHost.cpp#L355-L463)). Then it clicks natively at the centre.

If the document is replaced during that wait, WebKit keeps the old one in its back-forward cache, where `requestAnimationFrame` never fires. The wait never ends, and Bun then refuses every later input call on the view with `a simple operation is already pending`. Probes on Bun 1.4.4 (scripts in the session scratchpad, `probe267/`) showed this in 6 runs of 6, and showed two limits on any fix:

- An `evaluate` whose promise awaits `requestAnimationFrame` hangs the same way. The wait may only use evaluates that return at once.
- Judging stability by time (two polls 16 ms apart) clicked a moving button in 3 runs of 3, because both polls fell in one frame. Stability has to be counted in frames.

## Design

bowser runs the same wait itself with synchronous evaluates, then calls `view.click(x, y)`. No poll awaits anything in the page, so a document suspended between two polls leaves no call pending.

### The poll

`clickPollScript(selector, doc?)` in `src/page-scripts.ts` is one synchronous expression. It:

- keeps a frame counter `f` on the window under `Symbol.for('bowser.frames')`. Each poll starts an rAF loop if none is running; the loop increments `f` every frame and stops 100 ms after the last poll. A new document starts at `f = 0`;
- reads the document token: the ref store's `doc` when `doc` is given (#111), else `DOC_ID` (`src/page-scripts.ts:797`);
- finds the element with `document.querySelector(selector)`;
- returns `[token, f, left, top, width, height, hit]` when the element has a non-zero box with its centre in the viewport, `hit` being whether `document.elementFromPoint` at the centre is the element or a descendant. Otherwise it returns `[token, f]`.

### The loop

`Browser.click(selector, timeoutMs, doc?)` polls every 4 ms. A pure function, `clickStep(previous, sample, expected)` in `src/browser.ts`, decides after each poll:

- `navigated` when the sample's token differs from the expected one. The expected token is `doc` when given, else the first poll's token;
- `click` at the box centre when the sample is from the frame right after `previous`, both have the same box, and the sample's `hit` is true;
- `retry` otherwise.

On `click` bowser calls `view.click(left + width / 2, top + height / 2)` with no options. The wait ends at `timeoutMs`, 30000 ms when absent, with `timeout waiting for '<selector>' to be actionable`, the text Bun throws today. The daemon's budget (`src/daemon/server.ts:553`) and its mapping of that text to the acting timeout (`src/daemon/server.ts:260`) stay as they are.

`navigated` fails with `click: the page navigated before the click; nothing was clicked, run 'bowser snapshot' to see the new page`. It is a daemon error, so the CLI exits 2. `fill` clicks through `Browser.click` and gives the same message. A same-document navigation (`pushState`, a hash change) keeps the token, so the wait goes on.

With #111: a first sample whose token differs from the ref's `doc` is #111's `{ gone: true }` (exit 1) instead of `navigated`; this replaces #111's separate pre-check evaluate. Whichever PR lands second adapts to the other.

`resolve` still scrolls the target into view and refuses a covered or disabled one before the click (#112). ACTS, the dialog sync, `NAV_ARM` and the wait for a navigation the click starts run as today.

### Cost

One poll sends about 0.9 KB of script and gets back under 100 bytes; it took 0.09 ms median in the probe. In the page there is one small object per document and an rAF callback per frame while bowser polls. Nothing is written to disk.

## Out of scope

- Playwright's actionability beyond Bun's checks (the `visibility` check, the retry backoff, waits for `hover`, `check`, `uncheck` and `select`): #270.
- A page that seals its document reads the same `DOC_ID` before and after a navigation, so the click can land on the new page: #274.
- A document that commits between the last poll and `view.click(x, y)` is clicked at those coordinates.

## Definition of done

1. E2E: `tests/e2e-click-nav.test.ts` serves page A, whose button moves every frame and which navigates to B 300 ms after load, and page B, whose button sets `document.body.dataset.clicked`. With `BOWSER_OP_TIMEOUT_MS=3000`, `click` on A's button fails in under 3000 ms with the navigation message and exit 2; `eval document.body.dataset.clicked` then prints `undefined`; `snapshot` and `click` on B's button succeed and the mark reads `yes`, with no `bowser close` in between. On main the click times out and the next command reports `session is stuck`.
2. Unit: `tests/browser.test.ts` covers `clickStep`: frames n and n + 1 with the same box and `hit` click at the centre; frames n and n + 2 retry; a changed box retries; `hit: false` retries; a missing box retries; a changed token is `navigated`.
3. Unit: with a fake view and the fake clock, `Browser.click` calls `view.click(x, y)` at the centre and never `view.click(selector)`; a navigated sample rejects with the navigation message and records no click; a box that never settles rejects with the timeout text at `timeoutMs`.
4. Each test in items 1 to 3 fails when the production line behind its checked value is broken, and the PR body quotes one red line per test.
5. `tests/e2e-covered.test.ts`, `tests/e2e-hangs.test.ts`, `tests/e2e-actions.test.ts`, `tests/e2e-far-element.test.ts` and the #122 test in `tests/browser.test.ts` pass unchanged.
6. `bun run check` passes, and `BOWSER_E2E=1 bun test` passes in CI.
7. CHANGELOG `[Unreleased]` has a `Fixed` entry naming #267.
8. A Codex review ends with no open Critical or Required finding, and the PR closes #267.

Before the code (2026-10-30): `tests/e2e-click-nav.test.ts` does not exist, and `git grep -n clickStep -- src tests` matches nothing.
