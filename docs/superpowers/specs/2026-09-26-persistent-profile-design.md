# Spec: `open --persistent` and `open --profile=<dir>`

**Status:** approved (backlog item 5; raised in the 2026-09-05 refactor spec, "Backlog notes").

## Problem

Every bowser session starts with an empty in-memory browser store. A login is lost as soon as the
session's daemon exits (`close`, a crash, a reboot). On the chrome backend `state-save`/`state-load`
can carry cookies and localStorage across, but on WebKit (the macOS default) there is no way at all.
`playwright-cli` 0.1.13 has `open [url] --persistent` ("use persistent browser profile") and
`open --profile <path>` ("path to a persistent user data directory"); bowser has neither.

`Bun.WebView` supports it: `dataStore: { directory }` persists cookies, localStorage and IndexedDB
under that directory (WebKit needs macOS 15.2+; on chrome it is `--user-data-dir`, one per Chrome
process, and bowser runs one daemon process per session).

## Behaviour

1. `bowser open [url] --persistent` starts the session's browser with its profile in
   `~/.bowser/profiles/<session>/` (created if missing). It is **not** inside
   `~/.bowser/sessions/<session>/`, because `close` deletes that directory; the profile must survive
   `close` and daemon restarts.
2. `bowser open [url] --profile=<dir>` uses `<dir>` (resolved to an absolute path against the current
   directory, created if missing) and implies `--persistent`. Both flags together: `--profile` wins.
3. Without either flag, behaviour is unchanged (ephemeral store).
4. The choice applies when the session's daemon starts. It is passed to the daemon at spawn time
   (argv or env, whichever the spawn code makes simplest, also in the compiled-binary `--daemon`
   path) and never changes while it runs. If `open --persistent`/`--profile` targets a session whose
   daemon is already running with a different store, the command fails with exit 1:
   `usage: session '<s>' is already open with a different profile; run 'bowser close' first`.
   `open` without the flags on an already-running persistent session just reuses it (no error), as
   every other command does.
5. `close` stops the daemon and removes the session directory as today, and leaves the profile
   directory untouched. Deleting a profile is `rm -rf` of that directory; the docs say so.
6. One profile directory is meant for one running session at a time; running two sessions on the
   same `--profile` is unsupported and documented as such (no locking).
7. If `Bun.WebView` rejects `dataStore` (for example WebKit on macOS older than 15.2), the error
   surfaces as a runtime error (exit 2) whose message names `--persistent`.

## Acceptance (public seams only)

1. Unit (`tests/commands.test.ts` or the existing daemon-spawn tests with fakes): `open --persistent`
   and `open --profile=rel/dir` hand the daemon the right absolute directory; no flag hands none;
   the "different profile" usage error with exit-1 classification; `close` leaves the profile
   directory in place (a real temp HOME).
2. E2E on WebKit and Chromium: open a local page with `--persistent`, set a cookie
   (`cookie-set` on chrome, or `document.cookie` via `eval` on both) and a `localStorage` item,
   `close`, `open` the same session again with `--persistent`: both are still there. The same flow
   without the flag: both are gone. Same for `--profile=<tmp dir>`.
3. Compiled binary: the CI step that drives `dist/bowser` also runs `open --persistent` once, so the
   `--daemon` spawn path carries the option.
4. Docs: README and SKILL.md `open` rows show both flags, where the profile lives, that `close` keeps
   it and how to delete it; CHANGELOG under `## [Unreleased]`; CLAUDE.md gets a gotcha line on why
   the profile lives outside the session directory.

## Out of scope

Sharing Safari's or Chrome's own user profile; `--headed`; a `delete-data` command; locking a profile
against concurrent sessions; migrating `state-save`/`state-load` to WebKit.
