# hover, check, uncheck and select wait for their target as click does (#270)

Issue: #270. Builds on the click wait of #267 (PR #269) and the hover events of PR #275.
Status: implemented in this branch (PR #290).

## Goal

`hover`, `check`, `uncheck` and `select` wait for their target the way Playwright v1.64.1 does, within the op budget, and send nothing when the wait runs out. `click` also stops pressing an element that `visibility: hidden` hides. Where bowser differs from Playwright, the table below says why.

## What happens today

`click` waits in bowser's own loop (`Browser.click`, `src/browser.ts:843`): `clickPollScript` (`src/page-scripts.ts:801`) returns the target's box and whether it is the hit target at its centre, and `clickStep` (`src/browser.ts:328`) clicks once two consecutive frames show the same box and a hit. The other four actions run their page script at once (`src/browser.ts:905` to `:931`):

- `hover` dispatches its events at the target's centre whether or not the target is visible, moving or covered;
- `check` and `uncheck` call `el.click()` on the target, visible or not;
- `select` sets `selectedIndex` and fires `input` and `change` even on a disabled `<select>`. Probe on Bun 1.4.4: a `<select disabled>` read `b` after `selectedIndex = 1`.

`tests/e2e-stale-ref.test.ts:204` pins this: a `check` and a `hover` on targets hidden after the snapshot both go through.

The poll's visibility test is size only. The same probe showed a `visibility: hidden` button whose visible child covers its centre answering a hit (`[100, 40, "hidden", hit: true]`), so `click` presses it today. The probe also showed that size is not enough: a button under `content-visibility: hidden` and one inside a closed `<details>` both have a non-zero box (28 by 18 and 27 by 18 px), and `checkVisibility()` is false for both.

Before the wait, every one of these commands resolves the ref with `liveSelector` (`src/commands/context.ts:149`), which scrolls the target into view once. With `enabled: true` it refuses a disabled target at once (`click`, `check`, `uncheck`, spec F20); with `hit: true` it refuses a covered one (`click`, `fill`, #112).

## What each action waits for

Playwright's checks are from `docs/src/actionability.md` and `server/dom.ts` at [`cfe490d`](https://github.com/microsoft/playwright/tree/cfe490d941f992655948eee8fd4fd94e1c4234bf). Visible there means a non-zero box, `checkVisibility()` true and computed `visibility` of `visible` (`computeBox`, `injected/src/domUtils.ts:125`). Stable means the same box on two consecutive animation frames. Receives Events means the target or a descendant is the hit target at the action point.

| Action | Playwright waits for | bowser after this change | Why it differs |
| --- | --- | --- | --- |
| `click` (reference) | Visible, Stable, Receives Events, Enabled | Visible, Stable, Receives Events; disabled is refused before the wait | Playwright waits for Enabled until the budget runs out. bowser refuses at once with `ref 'eN' is disabled`, exit 1: its timeout says only `'<op>' timed out after Nms` (#282), so waiting would trade a reason the agent gets in milliseconds for a 30 s timeout without one. |
| `hover` | Visible, Stable, Receives Events | the same | |
| `check`, `uncheck` | Visible, Stable, Receives Events, Enabled; returns at once when the state already matches | Visible; disabled is refused before the wait | Enabled: as for `click`. Playwright presses the mouse at the centre, so the point must hold still and reach the target. bowser calls `el.click()` on the element, which hits it wherever it is. Waiting for a hit would also stall the common styled checkbox whose `<input>` sits under its label's decoration, which `el.click()` checks today. The state is read in `setCheckedScript`, after the wait, so a checkbox already in the asked state still waits to be visible. |
| `select` | Visible, Enabled; waits until the option exists (`error:optionsnotfound` retries) | Visible; disabled is refused before the wait; a missing option is refused after it | Enabled: as for `click`. Missing option: `ref 'eN' has no option "x"` stays immediate for a visible `<select>` (`docs/superpowers/specs/2026-09-27-p1-fixes-design.md:91`); waiting the budget for a typo would cost an agent 30 s with the same reasonless timeout. The wait for the option is #291. `selectScript` reads the options only after the wait, so a `<select>` that stays hidden fails with the timeout, exit 2, even when the option is missing. |

`fill` sends `click` first, so its click step gets the visibility change too. `type` and `press` wait for nothing, as in Playwright.

### Disabled targets

A disabled target is refused at once with `ref 'eN' is disabled`, exit 1, nothing sent, as F20 does today for `click`, `check` and `uncheck`. `select` joins them: `cmdSelect` passes `enabled: true` to `liveSelector`. Playwright waits for Enabled until the budget runs out, then fails with "element is not enabled". bowser's waiting timeout says only `'check' timed out after 30000ms` (#282), so waiting would turn a reason the agent gets in milliseconds into a 30 s timeout without one.

This narrows #270's What item: no E2E test has a target that becomes enabled within the budget, since none is waited for.

## Design

### The poll

`clickPollScript(selector)` keeps its name, its frame counter and its `[doc, frame, left, top, width, height, hit]` answer. Two things change:

- The box is returned only when the element is visible in Playwright's sense: non-zero size, `el.checkVisibility()` true, and `getComputedStyle(el).visibility === 'visible'`. Otherwise the answer is `[doc, frame]`, as for a missing element.
- The box is returned even when its centre is outside the viewport; `hit` is then false. `click` and `hover` behave as before (no hit, no action), and `check`, `uncheck` and `select`, which do not test the hit, can act on a visible target below the fold, as Playwright does.

### The step

`clickStep(previous, sample, expected, pointer)` gains `pointer`. With `pointer` true it is today's rule (same box on consecutive frames, and a hit). With `pointer` false it acts on the first sample that has a box. A changed token is `navigated` in both.

### The loop

The loop inside `Browser.click` moves to one function in `wrapView`, `untilActionable(op, selector, timeoutMs, doc, pointer)`. It runs inside `nav.waiting`, polls every 4 ms as `click` does today, and answers the box centre, or #111's gone when the first sample's token is not `doc`. `click`'s `doc` is required, and today's loop answers gone when the first token is not `doc` (`src/browser.ts:854`). The other four take an optional `doc`: when it is absent there is no gone check, and the first sample's token is the one a later sample is compared with for `navigated`. Each action calls it, then acts:

| Browser method | `pointer` | then |
| --- | --- | --- |
| `click(selector, timeoutMs, doc)` | true | `view.click(x, y)`, as today |
| `hover(selector, doc, timeoutMs)` | true | `hoverScript` and the change watch of PR #275 |
| `select(selector, value, doc, timeoutMs)` | false | `selectScript` |
| `setChecked(selector, checked, doc, timeoutMs)` | false | `setCheckedScript` |

The page scripts keep their own `doc` guard, since a document can commit between the last poll and the script. `timeoutMs` defaults to 30000 ms, as for `click`.

No new option, no scroll on each attempt and no retry backoff. Playwright waits 0, 20, 100, 100, then 500 ms between attempts; the #270 comment measured a backoff version of `click` on Bun 1.4.4 reacting later than the 4 ms poll (a button that moved for 1 s was clicked after 1318 to 1324 ms; one clickable at once took 11 to 17 ms against 7 to 14 ms), while one poll costs 0.09 ms median (#267). Scrolling on each attempt is #288.

### The daemon

The protocol's `hover`, `select`, `check` and `uncheck` args gain a `timeoutMs?` after `doc`, as `click` has: `[selector, doc?, timeoutMs?]`, and `[selector, value, doc?, timeoutMs?]` for `select`. `runShimmed` writes it at that index and leaves `doc` in place, `undefined` included. `runShimmed` (`src/daemon/server.ts:552`) gives each of the five ops the time left to its handler deadline, so the wait's own timeout answers before the budget's timer, for the reason #267 found. The mapping at `src/daemon/server.ts:260` turns `timeout waiting for '<selector>' to be actionable` into `timeoutMessage(req, budget)` for all five, not only `click`.

### Messages

| When | Message | Exit |
| --- | --- | --- |
| The wait runs out, or the budget's timer fires during it | `'hover' timed out after 3000ms` (`'check'`, `'uncheck'`, `'select'` alike), nothing sent | 2 |
| The budget's timer fires after the page script was sent | today's `'hover' timed out after 3000ms; the hover may have been delivered, check the page before retrying` | 2 |
| The document is replaced during the wait | `hover: the page navigated before the hover; nothing was hovered, run 'bowser snapshot' to see the new page`, with `check`/`checked`, `uncheck`/`unchecked`, `select`/`selected` | 2 |
| The target is disabled | `ref 'eN' is disabled`, now for `select` too | 1 |

`click`'s messages are unchanged.

### Cost

No storage. The page keeps only the existing `bowser.frames` record. The poll grows by about 100 bytes. A `hover` now waits at least two frames before its events, as `click` does (7 to 14 ms for a target ready at once, #270 comment); `check`, `uncheck` and `select` cost one poll, about 0.1 ms, when the target is visible. Four navigated messages and four timeout texts are added.

## Out of scope

- Scrolling the target into view on each attempt, and Playwright's cycling of `scrollIntoView` alignments: #288. Today's single scroll in `resolve` misses a target that becomes visible below the fold during the wait, so `click` and `hover` wait out the budget for it.
- A hit-target check inside the page while the pointer events arrive (`setupHitTargetInterceptor`): #289.
- `display: contents` targets, which Playwright counts visible through their children; they have no box, so bowser waits them out, as `click` does today.
- Reading the checked state before the wait, so a `check` on an already checked, hidden checkbox returns at once as in Playwright.
- Waiting for a `select` option to appear: #291.

## Definition of done

- [x] 1. E2E, `tests/e2e-action-wait.test.ts`, hover: a button with a `mouseenter` handler that marks `document.body.dataset.hovered` moves every frame until 600 ms after the test starts it. `hover` on it answers `hovered eN` no sooner than 600 ms after the start and the mark reads `yes`. On main `hover` answers before the button stops.
- [x] 2. E2E, same file: on a button that moves every frame and never stops, with `BOWSER_OP_TIMEOUT_MS=3000`, `hover` fails within 4000 ms with `'hover' timed out after 3000ms`, exit 2, and the mark reads `undefined`. On main the mark reads `yes`.
- [x] 3. E2E, same file, check and uncheck: a checkbox hidden with `visibility: hidden` after the snapshot and shown again 500 ms later is checked by `check` (and, in a second case, unchecked by `uncheck`) no sooner than 500 ms after the hide. One that stays hidden fails `check` and `uncheck` with `'check' timed out after 3000ms` and `'uncheck' timed out after 3000ms`, exit 2, its state unchanged. On main the hidden checkbox changes state at once.
- [x] 4. E2E, same file, select: a `<select>` hidden after the snapshot and shown 500 ms later gets the value and one `change` event; one that stays hidden fails with `'select' timed out after 3000ms`, exit 2, value and change count unchanged. A disabled `<select>` fails at once with `ref 'eN' is disabled`, exit 1, value unchanged. On main all three change the value.
- [x] 5. E2E, same file, click: a `visibility: hidden` button whose visible child covers its centre fails `click` with `'click' timed out after 3000ms`, exit 2, and its handler does not run. On main the handler runs.
- [x] 6. E2E, same file, the two poll rules: a checkbox inside a `<details>` closed after the snapshot (a non-zero box, `checkVisibility()` false) fails `check` with `'check' timed out after 3000ms` and stays unchecked; on main it is checked. A checkbox far below the fold, hidden after the snapshot, is shown again 500 ms later while the page scrolls back to the top; `check` checks it with its centre outside the viewport; with a poll that drops the box outside the viewport it times out.
- [x] 7. Unit, `tests/browser.test.ts`: `clickStep` with `pointer` false acts on the first sample with a box and retries one without; the `pointer` true cases of #267 pass unchanged.
- [x] 8. Unit, same file, fake view and fake clock: `hover`, `select` and `setChecked` evaluate their page script only after the poll is ready; a target that never gets a box rejects at `timeoutMs` with the timeout text and the script is never evaluated; a changed token rejects with that op's navigated message and the script is never evaluated.
- [x] 9. Unit, `tests/daemon-handler.test.ts`: `hover`, `select`, `check` and `uncheck` receive the time left to the handler deadline as their last arg, and their wait's timeout text reaches the client as `'<op>' timed out after <budget>ms`.
- [x] 10. Unit, `tests/commands.test.ts`: `cmdSelect` resolves with `enabled: true`.
- [x] 11. Each test in items 1 to 10 fails when the production line behind its checked value is broken, and the PR body quotes one red line per test.
- [x] 12. `tests/e2e-stale-ref.test.ts:204` and the two `#80` tests at `:224` change to expect the timeout, with `BOWSER_OP_TIMEOUT_MS=2000`, in place of the action going through: a hidden ref is still not refused as changed or gone. `tests/e2e-click-nav.test.ts`, `tests/e2e-covered.test.ts`, `tests/e2e-hover.test.ts`, `tests/e2e-forms.test.ts` and `tests/e2e-actions.test.ts` pass unchanged.
- [x] 13. `bun run check` passes, and `BOWSER_E2E=1 bun test` passes in CI.
- [x] 14. CHANGELOG `[Unreleased]` has a `Changed` entry naming #270, and the command tables in `README.md` and `skills/bowser/references/commands.md` say that `hover`, `check`, `uncheck` and `select` wait for a visible target and that `select` refuses a disabled one (`docs/commands.md` has no section for these commands).
- [x] 15. A Codex review ends with no open Critical or Required finding, and the PR closes #270.

### Run before the code (2026-10-31, worktree at origin/main ae2a0ad)

- Items 1 to 6: `bun test ./tests/e2e-action-wait.test.ts` prints `Test filter "./tests/e2e-action-wait.test.ts" had no matches`; the file does not exist yet. The probe in "What happens today" is today's red for items 4 and 5; the details probe for item 6.
- Items 7 to 9: `git grep -n -e "the page navigated before the hover" -e checkVisibility -- src tests` matches nothing (exit 1).
- Item 10: `git grep -n "enabled: true" -- src/commands/interaction.ts` lists `click` (`:54`), `check` (`:220`) and `uncheck` (`:229`), not `select` (`:210`).
- Items 12 and 13 pass on main today and are checked after the code.

### Checked after the code (2026-10-31)

- Items 1 to 6 and 12: pass in CI run 41188132841 (e2e 312 pass, 14 skip, 0 fail). With origin/main's `src` (CI run 41189548379) all twelve new or changed e2e tests fail; with a poll that drops `checkVisibility()` and the out-of-view box (CI run 41188825797) only the two item 6 tests fail.
- Items 7 to 10: each test went red under one mutation of its line; the PR body lists them. The three hover-watch timings in `tests/browser.test.ts` gained the wait's one poll interval (4 ms), and the #111 gone test in `tests/daemon-handler.test.ts` reads the doc by index now that a time-left arg follows it.
- Item 13: `bun run check` passes locally (1276 pass, 406 skip, 0 fail).
- Item 15: Codex approved 955c50d.
