# Refs belong to the document they came from (#105)

**Issue:** #105. It replaces #102 and the closed PR #104.
**Status:** approved on #108, 2026-10-02.

## Goal

A ref acts only on the document whose snapshot handed it out. On any other document it fails before it touches the page, with exit 1. A same-document change (`pushState`, a `#hash` change) keeps the refs valid. The rule holds on every path: a successful navigation, a navigation a click started, a failed or timed-out one, and a document the back-forward cache brings back.

## How refs work today

- `snapshot` evaluates `SNAPSHOT_SCRIPT` and saves its `refs` with the URL and title (`src/commands/snapshot.ts:22-26`). `SessionState` has no field that names a document (`src/state.ts:25-34`).
- The walker keeps a ref store on `window[Symbol.for('bowser.aria-refs')]`: element → ref, ref → `WeakRef(element)`, and a counter that starts at 0 in each new store (`src/page-scripts.ts:433-436`, `479-486`). Every document numbers its refs from `e1`.
- A ref command reads the saved ref (`loadRef`, `src/commands/context.ts:80-84`) and then resolves it in the live page with one `evaluate` of `resolveRefScript` (`liveSelector`, `context.ts:93-109`). The script looks the id up in the current window's store; no store or no element gives `null`, which is "not found" (`src/page-scripts.ts:977-979`, `context.ts:105-107`). An element whose role or name differs gives the #91 refusal (`page-scripts.ts:985`, `context.ts:97-101`).
- `goto`, `go-back`, `go-forward`, `reload` and `click` save the new URL and title and keep the refs (`syncState`, `context.ts:179-181`; callers at `src/commands/navigation.ts:114`, `127` and `src/commands/interaction.ts:38`). `open <url>` saves `refs: []` (`navigation.ts:96-100`).

A fresh document has no store, so an old ref already fails there as "not found" (`tests/e2e-stale-ref.test.ts:129-156`). The hole is a ref from one document resolving on another document that has a store, or being resolved on one document and then acted on in another. Two paths reproduce on main (5af2dc5, run from the main checkout against a local server with two pages, each holding `button "OK"` as `e2` and `link "next"` as `e3`):

1. **Back-forward cache.** `open /a`, `snapshot`, `click e3` (to `/b`), `snapshot` (B's refs saved), `go-back`. A comes back from the cache with its window and its store; the daemon already relies on that (`src/daemon/server.ts:433-435`). Then `click e2`, B's ref, answers `clicked e2 (button "OK")`, exit 0, and A's title reads `A clicked`.
2. **A pending navigation (ET-10).** `/slow` answers after 14 s. `click e3` returns `clicked` after the 10 s navigation cap with the navigation still pending. `click e2` then resolves on A, which is still shown, because only `ACTS` ops wait for a pending navigation (`server.ts:343`, `361-371`, `475`) and the resolve is an `evaluate`. The `click` waits for `/slow` to land and clicks the selector computed on A in the new document: `clicked e2 (button "OK")`, exit 0, title `S clicked`, path `/slow`. The new document has no store, so no check ran on it.

A third path follows from the code but was not run: a `snapshot` whose evaluate ran in the page and whose save never happened (the request timed out, or the client died). That document has a store, and `state.json` still holds the previous document's refs with the same ids.

The case #102 named, a timed-out `goto` that leaves the old refs saved, is covered today by the missing store. With `BOWSER_OP_TIMEOUT_MS=2000` and a 5 s server, the recovery reload put the page back on `/a` as a new document, and `click e2` failed as "not found", exit 1.

## Design

### 1. A document id in the store and in the state

`SNAPSHOT_SCRIPT` gives the store a `doc` field when it creates it: 16 random bytes from `crypto.getRandomValues`, as hex. A store without `doc` (one a previous bowser made) gets one the same way, as a store without `byRef` gets that map today (`page-scripts.ts:436`). The script returns `doc` beside `refs`, and `SnapshotResult` gains `doc: string`.

`snapshot` saves it as `SessionState.doc`, in the same `saveState` as the refs. All saved refs come from one snapshot, so one id per session is enough. Nothing else writes `doc`. `open <url>` writes a state with no refs and no `doc`; `syncState` copies both unchanged.

The id lives on `window`, so it survives `pushState` and hash changes and comes back with a cached document, and a new document starts without it. `crypto.getRandomValues` works on plain `http:` pages; `crypto.randomUUID` is limited to secure contexts by the Web Crypto spec (not measured here). A page that replaces `getRandomValues` with a constant gets the same id in every document, which leaves it with today's checks and nothing worse.

### 2. The check runs when a ref is resolved

`resolveRefScript` takes the saved `doc`. Before it looks the ref up, it compares it with `store?.doc`. If they differ (that includes no store, and a state saved without `doc`), it answers `{ gone: true }`. `liveSelector` turns that into the error in section 3. The element lookup, the #91 role and name check and the `enabled` check run only when the documents match, unchanged.

Refs are not cleared when the state is saved. `syncState` stays as it is. Clearing at save time would need the current document's id after every navigating command, which costs an extra evaluate, and after a timeout that read fails or waits behind the running navigation (the PR #104 finding). It would also miss the back-forward path, where no bowser command saved anything between the two snapshots. The check at resolve time needs no request after a failure: the next ref command finds out in the page, in the request it already sends.

### 3. The resolve waits for a pending navigation

The resolve goes to the daemon as a new op, `resolve` (`args: [expr]`, result as `evaluate`). The daemon's handler gives it the pending-navigation wait `click` already has (`server.ts:343`, `361-371`) and then runs `browser.evaluate(expr)`. `liveSelector` sends `resolve` instead of `evaluate`; no other caller changes.

`resolve` is not in `ACTS`. A first draft put it there, but every `ACTS` op runs inside the navigation watch (`tests/browser.test.ts:884`), and that adds the watch's 100 ms grace window to every ref command. The resolve's only side effect is a scroll into view.

With the wait, path 2 resolves in the document that landed. That document has no store, or one with another id, so the ref fails before the click is sent. If the navigation is still pending when the budget ends, the command fails with the existing `page is still loading <url>; retry later, or run 'bowser close'`, exit 2, as a `click` does today in that state.

`eval` and `snapshot` keep using `evaluate` and do not wait.

### 4. What the user sees

A ref whose document is gone fails with a `UserError`, exit 1, before any action request:

```
ref 'e2' is from a page that is no longer loaded; take a new snapshot
```

This message covers every document mismatch, including a document with no store, which today reads "not found". The agent learns that the page changed, not that an element went away, and "take a new snapshot" matches the #91 message. The goto and reload cases change their message: `tests/e2e-stale-ref.test.ts:129-156` and `170-185` expect the new text, and README (line 178) and `skills/bowser/SKILL.md` (line 106) describe both messages. `ref 'eN' not found …` stays for an element gone from the same document.

Considered: keeping playwright-cli's `not found` text for a mismatch too. It changes no existing test or doc, but the agent cannot tell a navigation from a re-render. The owner chose the new message on #108.

### 5. Interplay

- **#91.** Unchanged. It runs only once the documents match, so it now guards re-renders within one document only.
- **ET-10 wait.** Section 3. The resolve waits under the same budget the command has, and a timeout during the wait gives the existing "still loading" message.
- **Timeouts.** No new request after a failed `open`, `goto`, `click` or history command. The saved refs stay, and the next ref command refuses them in the page if the document changed. If the document did not change (the navigation never committed), the refs still work.
- **Back-forward cache.** A document the cache restores keeps its store and its id. Refs saved from that document work again after `go-back`, which is correct; refs from the document that was left fail.
- **Persistent sessions.** A profile keeps cookies and storage, not windows. After the daemon restarts, every document is new, so saved refs fail with the message until the next `snapshot`, as they fail with "not found" today.
- **Upgrade.** A `state.json` saved by an older bowser has refs and no `doc`, so its refs fail once with the message. One `snapshot` fixes it.
- **`snapshot`.** It is the only writer of refs and `doc`. On a document that already has a store it reuses its id and its counter, as today.
- **MCP.** Tools call the same commands, and a thrown error becomes a tool result with `isError: true` and the message as its text (`src/mcp.ts:207-216`). Nothing MCP-specific changes.
- **Other clients.** The session gate (#77) already orders whole commands, so a resolve and its action run with no other client's command between them.

## Definition of done

1. **Back-forward path fixed.** An e2e test with two pages that each have `button "OK"` at the same ref: `open` A, `snapshot`, `click` the link to B, `snapshot`, `go-back`, `click` the OK ref. On main it exits 0 and A's title changes. After the change it fails with `ref 'e2' is from a page that is no longer loaded; take a new snapshot`, exit 1, and A's title is unchanged.
2. **Pending-navigation path fixed.** An e2e test with a link to a page served after the 10 s navigation cap (14 s in the probe): `click` the link returns, then `click` the OK ref. On main it clicks the new page's button, exit 0. After the change it fails with the message, exit 1, and the new page's title is unchanged. A variant that runs the second `click` with `BOWSER_OP_TIMEOUT_MS=2000`, while about 4 s of the navigation remain, fails with `page is still loading …`, exit 2, and clicks nothing.
3. **Lost-save path fixed.** An e2e test: `snapshot` the kitchen-sink page, `goto` the same URL, run `SNAPSHOT_SCRIPT` through `eval` (a snapshot whose save was lost), `click` the saved Submit ref. On main it clicks, exit 0. After the change it fails with the message, exit 1.
4. **Same document kept.** After `snapshot`, `eval history.pushState({}, '', '/other')` and then `eval location.hash = 'x'`, a ref still clicks, exit 0.
5. **Exact message and exit code.** `tests/exit-codes.test.ts` has a `click e1` case whose `resolve` answers `{ gone: true }`, with the message on stderr and exit 1. A unit test in `tests/commands.test.ts` checks that `liveSelector` sends `resolve` with the saved `doc`.
6. **Daemon.** A `tests/daemon-handler.test.ts` case shows `resolve` waiting for a pending navigation, as `click` does.
7. **Existing behaviour.** The #91 tests, the `e2e-stale-ref` tests (with the message updated), the ET-10 tests in `tests/e2e-known-state.test.ts` and `tests/e2e-hangs.test.ts`, and the MCP tests pass. A snapshot on a store from a previous version gets an id and keeps its numbering (`tests/e2e-stale-ref.test.ts:162-168`).
8. **Tests seen failing.** Items 1 to 3 and 5 to 6 fail on main and pass after.
9. **Checks.** `bun run check` and `BOWSER_E2E=1 bun test` pass. CI is green.
10. **Docs.** README and `skills/bowser/SKILL.md` describe the message, and CHANGELOG `[Unreleased]` has an entry.
11. **Review and issue.** A Codex review ends with no open Critical or Required finding, and the PR closes #105.

## Out of scope

- A navigation that starts between the resolve and the action (a page timer firing in that gap). The action would run on the new document; closing that needs the document check inside each action op.
- Iframe refs, which bowser does not snapshot.
- Clearing refs in `state.json` on navigation.

## Possible later

- `snapshot` waits for a pending navigation, so it describes the page the next action will land on.
- Each action op checks the document id itself, which closes the gap above.
