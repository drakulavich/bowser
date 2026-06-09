# Cookies via CDP — Design

**Date:** 2026-05-14
**Status:** Design — revised at implementation time (2026-06-10)
**Target version:** Unreleased (after `sessionstorage-*` / `eval` / `run-code`)

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

## Revision (2026-06-10)

The transport section of this spec was superseded during implementation. Investigation against Bun 1.3.13 found:

- **`Bun.WebView` launches Chrome with `--remote-debugging-pipe`**, not `--remote-debugging-port`. Chrome communicates over pipe file-descriptors 3/4, not a TCP WebSocket port. It therefore does **not** emit the `DevTools listening on ws://…` line to stderr, so the stderr-scrape approach does not work.
- **`Bun.WebView` exposes no `onStderr` hook**: only `stderr: "inherit" | "ignore"` is available, so there is no way to capture stderr programmatically from bowser.
- **Bun.WebView ships a first-class CDP API** (`view.cdp(method, params)` / `view.addEventListener("Domain.event", cb)`), Chrome backend only, verified working in Bun 1.3.13. This eliminates the need for a separate WebSocket transport, the dual-client attach risk, and the stderr-scraping fragility.

Therefore `src/cdp/client.ts` and `src/cdp/launch.ts` were **not implemented**. The daemon delegates cookie ops directly to `view.cdp()` via a `cdp()` method on the `Browser` interface. The `src/cdp/types.ts` types file is unchanged (still useful for the Cookie/CookieParam interface). Everything else in the spec (goals, CLI surface, daemon op table, HttpOnly-first-class) is implemented exactly as written below.

## Approach

`Bun.WebView` exposes `view.cdp(method, params)` (Chrome backend only) — a first-party CDP channel that is part of the same browser session the WebView already manages. The daemon delegates all cookie ops through this channel.

**No second CDP connection, no `--remote-debugging-port` injection, no stderr-scrape.** The `Browser` interface gains two methods:
- `cdpAvailable(): boolean` — true iff the chrome backend is active.
- `cdp(method, params?): Promise<unknown>` — delegates to `view.cdp()`; on webkit rejects with the chrome-backend required error immediately.

Cookie ops are routed through the existing serializer like all other ops (CLAUDE.md gotcha: never bare-dispatch).

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

## Implementation outline (as built)

| Path | Status | Responsibility |
|---|---|---|
| `src/cdp/types.ts` | new | `Cookie`, `CookieParam`, `DeleteCookieOptions` types mirroring CDP Network domain. No runtime dep. |
| ~~`src/cdp/client.ts`~~ | not built | superseded by `view.cdp()` — see Revision note above. |
| ~~`src/cdp/launch.ts`~~ | not built | superseded by `view.cdp()` — see Revision note above. |
| `src/browser.ts` | extend | `Browser` interface gains `cdpAvailable(): boolean` and `cdp(method, params?): Promise<unknown>`; `openBrowser` implements them via `view.cdp()` (chrome) or a rejection with the chrome-backend required message (webkit). |
| `src/daemon.ts` | extend | adds four cookie ops routed through the serializer; each calls `browser.cdp("Network.*")`. |
| `src/commands.ts` | extend | `cmdCookieList/Get/Set/Delete/Clear`; default URL from daemon `state` op. |
| `src/cli/schemas.ts` | extend | five new command schemas with the flags above. |
| `src/cli.ts` | extend | dispatch + help text (HttpOnly-first-class note in help). |
| `tests/cookie.test.ts` | new | 31 unit tests against an extended `fakeClient` handling the four new ops. |
| `tests/e2e-cookie.test.ts` | new | 8 e2e tests gated on `BOWSER_E2E=1 && BOWSER_BACKEND=chrome`; serves a local HTTP page for cookie origin; HttpOnly core risk confirmed. |
| `README.md` | extend | command table + roadmap tick. |
| `skills/bowser/SKILL.md` | extend | command reference + HttpOnly note. |
| `CHANGELOG.md` | append | `cookie-*` entry. |

## Risks and mitigations (updated)

- ~~**Chrome stderr parsing for the debug port.**~~ Eliminated — `view.cdp()` needs no port, no stderr scrape.
- ~~**Two CDP clients on one Chrome.**~~ Eliminated — `view.cdp()` uses the same session Bun already owns.
- **HttpOnly correctness.** Asserted in `tests/e2e-cookie.test.ts`: set HttpOnly cookie via `cookie-set --http-only`, serve a local HTTP page (same origin as the cookie scope), confirm it appears in `cookie-list` but NOT in `document.cookie`. Verified passing.
- **Compile-target size.** No new npm deps. Binary delta vs stack base: **+16 KB** (well under the 1 MB threshold).

## Out of scope (next spec)

- `state-save` / `state-load` (storage-state JSON: cookies + localStorage + sessionStorage in one file). Will reuse this CDP client plus the existing Web Storage commands.
- Tab management (`tab-*`) — uses CDP `Target.*` methods, also built on this client.
