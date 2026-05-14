# Cookies via CDP — Design

**Date:** 2026-05-14
**Status:** Design — pending implementation
**Target version:** TBD (first command set after `sessionstorage-*`)

## Goal

Implement `cookie-*` commands that cover the full cookie surface a real agent flow needs, including **HttpOnly** and **Secure** cookies. These are exactly the cookies set by auth servers for session tokens — without them, `cookie-list` would silently omit the most important rows on any logged-in page, which is the misleading-partial-API trap.

The same Chrome DevTools Protocol (CDP) plumbing introduced here is reused later by `state-save` / `state-load` (full storage-state dump/restore) and by future commands that need element-bounded screenshots, network mocking, or tab management.

Non-goals in v1: cookie observation across all frames (we target the top frame's URL/domain), cookie partitioning attributes beyond what Chromium exposes by default, programmatic eviction policies.

## Why `document.cookie` is insufficient

`document.cookie` cannot see, set, or delete:

- `HttpOnly` cookies (most auth/session cookies)
- Cookies for cross-origin domains the page is not currently on
- Cookies with attributes the JS DOM can't express (`SameSite=None` server-only paths, partitioned cookies, etc.)

It also can't enumerate — you only get a flat `name=value; name=value` string with no attributes, so even for non-HttpOnly cookies you cannot accurately reproduce them on another machine. Shipping a `document.cookie`-only `cookie-list` would return rows that look complete but are missing every cookie an agent actually cares about. That is worse than not shipping the command at all.

## Approach

Introduce a CDP transport in the daemon that runs alongside the existing `Bun.WebView` driver. The daemon owns one CDP connection per session; cookie ops (and future CDP-only ops) are routed through it.

**Cooperation with `Bun.WebView`:** CDP supports multiple clients per Chrome instance (`/json/version` returns a `webSocketDebuggerUrl` and additional clients can attach). The WebView's own protocol traffic and our CDP traffic do not interfere — they are separate sessions over separate WebSocket connections.

**Launch flags:** the daemon sets `--remote-debugging-port=0` in Chrome's argv (via the existing `BOWSER_CHROME_ARGS` mechanism extended to a daemon-injected default). Port 0 asks the kernel for a free port; the actual port is reported on Chrome's stderr (`DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>`). The daemon captures stderr, parses that line, and stores the browser-level WS URL. (Future: prefer `--remote-debugging-pipe` to avoid stderr-scraping, once we confirm it round-trips on every supported Chrome channel.)

Once the browser WS URL is known, the daemon fetches `http://127.0.0.1:<port>/json/version` to confirm reachability, then resolves the active page target by calling `Target.getTargets` on the browser-level connection and matching the URL the WebView reported. The daemon opens a second WS to that page target's `webSocketDebuggerUrl` and treats it as the per-page CDP channel.

## Daemon protocol additions

New ops on `DaemonRequest["op"]`:

| Op | Args | Result |
|---|---|---|
| `cookie-get-all` | `[urls?: string[]]` | `Cookie[]` (CDP `Network.getCookies` if `urls` set, else `Network.getAllCookies`) |
| `cookie-set` | `[cookie: CookieParam]` | `{success: boolean}` (CDP `Network.setCookie`) |
| `cookie-delete` | `[name: string, opts: {url?, domain?, path?}]` | – (CDP `Network.deleteCookies`) |
| `cookie-clear` | `[]` | – (CDP `Network.clearBrowserCookies`) |

`Cookie` and `CookieParam` mirror CDP's [`Network.Cookie`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-Cookie) and [`Network.CookieParam`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-CookieParam) types. We re-export them in a new `src/cdp/types.ts` (no runtime dep on `playwright-core`; types only).

`cookie-set` requires either `url` or `domain` (the CDP API does too). We default `url` to the current page's URL when callers pass only `name=value`, matching `playwright-cli`'s ergonomics.

## CLI surface

| Command | Args | Behavior |
|---|---|---|
| `cookie-list` | `[--domain=<d>] [--url=<u>] [--json]` | Print all cookies. Default: scoped to current page URL; `--domain` filters; `--url` overrides scope. Text mode: `name=value` per line; `--json` returns the full CDP shape (attributes included). |
| `cookie-get` | `<name> [--domain=<d>] [--url=<u>]` | Print value (text) or `{ok, cookie}` (JSON). Empty/no-output if not found. |
| `cookie-set` | `<name> <value> [--domain=<d>] [--url=<u>] [--path=<p>] [--http-only] [--secure] [--same-site=Lax\|Strict\|None] [--expires=<unix-seconds>]` | Set one cookie. At least one of `--domain`/`--url` is required, else we default `--url` to the current page. |
| `cookie-delete` | `<name> [--domain=<d>] [--url=<u>] [--path=<p>]` | Delete matching cookie(s). |
| `cookie-clear` | – | Wipe **all** browser cookies in this session's Chrome profile. |

**Critically:** all five commands operate on **HttpOnly cookies as first-class data**. No flag suppresses or hides them. Help text and SKILL.md explicitly call this out: "HttpOnly cookies are visible to `cookie-list` / `cookie-get` and settable via `cookie-set --http-only`."

## Implementation outline

| Path | Status | Responsibility |
|---|---|---|
| `src/cdp/client.ts` | new | minimal CDP client: ws connect, `send(method, params)` → promise, event subscription. ~120 LOC. No npm dep — Bun has built-in WebSocket. |
| `src/cdp/launch.ts` | new | parses Chrome stderr for `DevTools listening on ws://…`, resolves page target via `/json/version` + `Target.getTargets`. ~80 LOC. |
| `src/browser.ts` | extend | accept an `onStderr` hook so the daemon can scrape the debug URL; expose `cdpEndpoint()` getter. |
| `src/daemon.ts` | extend | own the CDP client lifecycle; add cookie ops. |
| `src/commands.ts` | extend | `cmdCookieList/Get/Set/Delete/Clear` using `loadState` for the default URL. |
| `src/cli/schemas.ts` | extend | five new command schemas with the flags above. |
| `src/cli.ts` | extend | dispatch + help text. |
| `tests/cookie.test.ts` | new | unit tests against an extended `fakeClient` handling the new ops. |
| `tests/e2e-cookie.test.ts` | new | e2e: open a `data:` URL, set/get/delete a cookie via CDP, verify roundtrip including HttpOnly. |
| `README.md` | extend | command table + roadmap tick. |
| `skills/bowser/SKILL.md` | extend | command reference. |
| `CHANGELOG.md` | append | `cookie-*` entry. |

## Risks and mitigations

- **Chrome stderr parsing for the debug port.** Fragile across channels/versions. Mitigation: regex is loose (`/DevTools listening on (ws:\/\/\S+)/`), and we test on the Playwright-pinned `chrome-headless-shell` build that bowser already downloads via `bowser install`. Future: switch to `--remote-debugging-pipe` (file-descriptor transport) once confirmed working under `Bun.spawn`.
- **Two CDP clients on one Chrome.** Confirmed supported by CDP, but Bun.WebView's internal protocol must not refuse a second attach. To de-risk, the new e2e test runs alongside an active WebView (open + snapshot) and exercises both paths in the same daemon process.
- **HttpOnly correctness.** Asserted explicitly in the e2e test: set an HttpOnly cookie via `cookie-set --http-only`, observe it absent in `document.cookie` but present in `cookie-list`.
- **Compile-target size.** Adding a CDP client should not pull in npm deps (Bun built-in WebSocket only). Verify `dist/bowser` binary size delta is < 1 MB in CI.

## Out of scope (next spec)

- `state-save` / `state-load` (storage-state JSON: cookies + localStorage + sessionStorage in one file). Will reuse this CDP client plus the existing Web Storage commands.
- Tab management (`tab-*`) — uses CDP `Target.*` methods, also built on this client.
