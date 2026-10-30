# hover sends the pointer's entry events and says when the page did not react (#270)

Issue: #270 (the hover part). Status: draft, waiting for review.

## Goal

`bowser hover` opens menus that open on `mouseenter` or `pointerenter` as well as `mouseover`. When the page does not change after the hover, the answer says so, so an agent does not assume a CSS `:hover` menu is open.

## What happens today

`hoverScript` (`src/page-scripts.ts:890`) dispatches a synthetic `mouseover` and `mousemove` at the target's centre, and `bowser hover eN` answers `hovered eN`. Synthetic events never set CSS `:hover`, and nothing sends `mouseenter`. Bun.WebView has no native pointer move: `bun.d.ts` has `click(x, y)` and nothing else that moves the pointer.

Probe on Bun 1.4.4 (000ef5037), darwin arm64, script `probe270/menus.ts` in the session scratchpad. The page has four menus, each opened a different way: CSS `:hover`, an `onmouseover` handler, a `mouseenter` listener, and a `mouseenter` listener that opens its menu 150 ms later (hover intent).

- Today's two events open the `mouseover` menu only: `[css, over, enter, intent]` read `[false, true, false, false]`.
- The entry sequence below opens the `mouseover` and `mouseenter` menus, and the hover-intent menu once 150 ms have passed: `[false, true, true, true]` when read 200 ms after the hover. The CSS menu stays closed.
- A MutationObserver armed before the events saw the change from both synchronous menus at 0 to 1 ms, from the hover-intent menu at 151 ms, and no change from the CSS menu.

## Design

### The events

`hoverScript(selector, doc?)` keeps its `doc` check (#111) and the centre point, and dispatches what a real pointer sends when it arrives on the element from outside the page:

1. `pointerover` on the target;
2. `pointerenter` on each element the pointer enters, outermost first: the target and its ancestors up to `<html>`, crossing a shadow root to its host;
3. `mouseover` on the target;
4. `mouseenter` on the same elements as step 2, in the same order;
5. `pointermove` on the target;
6. `mousemove` on the target.

All carry `clientX`, `clientY`, `view: window` and `composed: true`. The `over` and `move` events bubble and are cancelable, the `enter` events do neither. The pointer events carry `pointerType: 'mouse'` and `isPrimary: true`.

### Did the page change

Before the events, the script disconnects the previous hover's observer if there is one, and arms a MutationObserver on `document` (`subtree`, `childList`, `attributes`, `characterData`) that records the first change on the window under `Symbol.for('bowser.hover')`. The script returns at once; nothing in it awaits, for the reason #267 found: an evaluate that awaits never settles once its page goes into the back-forward cache.

`Browser.hover` then reads the record with a synchronous evaluate every 10 ms until it shows a change or 200 ms have passed, and disconnects the observer on the last read. A read that finds no record means the document was replaced, which counts as a change. The window is 200 ms so that a hover-intent delay like the probe's 150 ms is caught; a page that changes at once ends the wait at the first read.

`Browser.hover` answers `true` (changed), `false` (no change within 200 ms) or #111's gone. The protocol's `hover` result becomes `boolean | Gone`.

### The answer

- Changed: `hovered e3`, as today. `--json` adds `"changed": true`.
- No change: `hovered e3; the page did not change within 200 ms (bowser cannot trigger CSS :hover)`, exit 0. `--json` adds `"changed": false`.

### Cost

The script grows by about 1 KB. A hover that changes the page costs one more evaluate (under 2 ms in the probe); a hover that changes nothing costs 200 ms more. The page keeps one record and one observer per document until the next hover's last read. Nothing is written to disk.

## Not doing

- An actionability wait before `hover` (Playwright's Visible, Stable, Receives Events): #270.
- Changes to `check`, `uncheck` or `select`: #270.
- Playwright's full actionability table: #270.
- Triggering CSS `:hover`, by rewriting style sheets or otherwise: the answer says it does not happen.
- `pointerout`, `mouseout` and the leave events on the element a previous hover entered.
- A native pointer move: Bun.WebView has none; an upstream request is drafted.

## Definition of done

1. E2E: `tests/e2e-hover.test.ts` serves a page with a CSS `:hover` menu, an `onmouseover` menu, a `mouseenter` menu and a 150 ms hover-intent menu. After `hover` on each, the `mouseover`, `mouseenter` and hover-intent menus are open and the CSS menu is closed. `hover` on the CSS menu answers `hovered eN; the page did not change within 200 ms (bowser cannot trigger CSS :hover)` and on the others `hovered eN`; with `--json` the CSS menu's answer has `"changed": false` and the others `"changed": true`. On main the `mouseenter` and hover-intent menus stay closed (1 of 3 of the first three open).
2. E2E, same file: a target that logs every pointer and mouse event it receives, inside a parent that logs its enter events, logs `pointerover, pointerenter (parent), pointerenter, mouseover, mouseenter (parent), mouseenter, pointermove, mousemove` after one `hover`.
3. Unit, `tests/browser.test.ts` with a fake view and the fake clock: a record that shows a change on the first read ends `hover` with `true` after one read; a record that never changes ends it with `false` at 200 ms; a read that finds no record answers `true`; a `doc` from another document answers gone without reading.
4. Unit, `tests/commands.test.ts`: `cmdHover` prints the no-change text and `"changed": false` when the daemon answers `false`, and today's text with `"changed": true` when it answers `true`.
5. Each test in items 1 to 4 fails when the production line behind its checked value is broken, and the PR body quotes one red line per test.
6. `tests/e2e-stale-ref.test.ts`, `tests/e2e-ref-window.test.ts` and the existing hover tests in `tests/commands.test.ts` and `tests/daemon-handler.test.ts` pass, changed only where the result type now carries `changed`.
7. `bun run check` passes, and `BOWSER_E2E=1 bun test` passes in CI.
8. CHANGELOG `[Unreleased]` has a `Fixed` entry naming #270, and `skills/bowser/references/commands.md` documents the no-change answer.
9. A Codex review ends with no open Critical or Required finding.

### Run before the code (2026-10-30, worktree at origin/main)

- Items 1 and 2: `bun test ./tests/e2e-hover.test.ts` prints `Test filter "./tests/e2e-hover.test.ts" had no matches`; the file does not exist yet. The probe above is today's red: `[false, true, false, false]`.
- Items 3 and 4: `git grep -n "did not change within" -- src tests` matches nothing (exit 1).
- Items 6 and 7 pass on main today and guard against regressions; they are checked after the code.
