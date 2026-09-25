# Spec: a stale ref fails at once, like playwright-cli

**Status:** approved (backlog item 3, ET-03 from the 2026-09-06 exploratory session; contract chosen
by the owner on 2026-09-26).

## Problem

A ref is saved in `state.json` as a CSS selector (`cssPath`, an `nth-of-type` chain from `html`).
When the element is gone after a re-render (the ET-03 case: a todo removed by "Clear completed"),
an action on its ref waits the full `BOWSER_OP_TIMEOUT_MS` (30 s by default; the ET-03 session had it set to 8 s) and fails with
`operation 'click' timed out` (exit 2). Worse, when the DOM shifts, the saved selector can match a
*different* element, and the action lands on the wrong target.

`playwright-cli` 0.1.13, measured on `tests/fixtures/todo-app.html` (add "alpha", toggle it, "Clear
completed", then `click` the old checkbox ref without a new snapshot), answers in ~130 ms with:

```
Error: Ref e12 not found in the current page snapshot. Try capturing new snapshot.
```

## Behaviour

1. The walker (`SNAPSHOT_SCRIPT`) already keeps, per document, a `WeakMap` element → `{ref, role,
   name}` and a counter on `window`. It also keeps the reverse: ref → `WeakRef(element)`, updated on
   every snapshot for every ref it hands out.
2. Every command that acts on a ref (`click`, `fill`, `hover`, `select`, `check`, `uncheck`, and any
   other command that calls `loadRef`) first resolves the ref in the page with one `evaluate`: the
   script looks the ref up in that map and, if the element is still connected to the document,
   returns a fresh selector for it (the same `cssPath` rule, computed now). The action then uses
   that fresh selector exactly as today.
3. If the page has no map (new document after navigation or reload), the ref is not in it, the
   `WeakRef` is empty, or the element is no longer connected, the command fails at once, before any
   action request, with:

   `ref 'eN' not found in the current page snapshot. Try capturing new snapshot.`

   This matches the existing user-error regex (`ref '.*' not found`), so the exit code is 1.
4. A ref that is not in `state.json` at all keeps today's `loadRef` error. The wrong-kind guard
   (spec 2026-09-25 §5) still runs first, from the saved ref, with no daemon request.
5. An element that exists but is hidden or covered keeps today's behaviour (the action's own
   waiting and timeout). Only a missing element fails fast.
6. The resolve script lives in `src/page-scripts.ts` and embeds the ref id with `JSON.stringify`.
   Cost: one extra daemon round trip per ref action; `cmdFill` goes from 3 to 4. Accepted by the
   owner for correctness.

## Acceptance (public seams only)

1. Unit (`tests/commands.test.ts`, `fakeClient`, seeded state): when the resolve `evaluate` returns
   "missing", each ref command rejects with the exact message and sends no action request; when it
   returns a selector, the action request uses that returned selector, not the saved one.
2. E2E on WebKit and Chromium (`tests/e2e-snapshot.test.ts` or a new `tests/e2e-stale-ref.test.ts`
   in the CI lists):
   - the ET-03 scenario: the stale checkbox ref fails in under 1 s with the message, and a new
     snapshot shows the page unchanged;
   - wrong target: two todos, snapshot, remove the first one by a page-side re-render, then act on
     the first one's old ref without a new snapshot; the command fails and the second todo is
     untouched (today it would be toggled through the shifted selector — the test must fail on
     `main`);
   - after `goto`/`reload`, an old ref fails with the message;
   - a ref from the current snapshot still works for every ref command exercised.
3. Docs: README and SKILL.md say an action on a ref from an old snapshot fails with that message
   and to snapshot again; CLAUDE.md notes the resolve step and the new RTT count for `cmdFill`;
   CHANGELOG entry under `## [Unreleased]`.

## Out of scope

Matching `playwright-cli`'s exit code (it prints the error and exits 0; bowser keeps exit 1 for
user errors). Auto-retrying with a new snapshot. Refs inside iframes.
