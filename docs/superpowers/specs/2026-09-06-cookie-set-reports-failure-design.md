# Spec: `cookie-set` reports failure instead of claiming success

**Status:** approved 2026-09-06. Plan: `docs/superpowers/plans/2026-09-06-cookie-set-reports-failure.md`.
**Origin:** ticket 3 of the post-refactor triage. The ticket described the
symptom; the measurements below found a broader cause and cancelled half of
the proposed fix.

## Assumptions I am making

Correct any of these now, or I proceed with them.

1. `playwright-cli` 0.1.13 is the compatibility reference for this behaviour,
   as it is everywhere else in bowser. Where the two disagree, bowser is wrong.
2. Changing `cookie-set` from "always reports success" to "reports what
   happened" is a wanted visible change. The refactor series deliberately kept
   output frozen; this ticket is the opposite kind of work.
3. The fix is scoped to `cookie-set`. Other commands that may discard a result
   are out of scope unless a measurement shows them broken (see Open questions).
4. Cookie commands are chrome-only today, so this is not testable on WebKit and
   the new e2e coverage goes in the chrome suite.

## What was measured, not assumed

Both tools, same local HTTP fixture, same flags.

| | `cookie-set bad v --sameSite=garbage` |
|---|---|
| `playwright-cli` 0.1.13 | `Error: '--sameSite' option: Invalid option: expected one of "Strict"\|"Lax"\|"None"` — the cookie is never created |
| `bowser` (main, 8621fbd) | prints `set bad`, exit 0 — and `cookie-list --json` returns `[]`, so nothing was created |

**Root cause** (`src/commands/cookies.ts:105`):

```ts
await c.request("cookie-set", [param]);
return reply(ctx, { ok: true }, `set ${name}`);
```

The op is declared `result: { success: boolean }` in `daemon/protocol.ts:50` —
CDP's `Network.setCookie` tells us whether the cookie was stored. `cmdCookieSet`
discards it and reports success unconditionally. An invalid `--same-site` is one
way to reach that; it is not the only one.

### The ticket's second fix is cancelled

The ticket proposed changing `normalizeSameSite`
(`src/commands/storage-state.ts`) so that "absent" is not folded in with "not one
of ours" to `Lax`. **Measurement says do not.** `playwright-cli` writes exactly
the same thing:

```
playwright-cli cookie-set plain v1 --domain=localhost --path=/    # no --sameSite
playwright-cli state-save out.json
→ { "name": "plain", ..., "sameSite": "Lax" }
```

Playwright's own API confirms the shape: `sameSite` is **optional** on
`addCookies` input but **non-optional** in `storageState()` and `cookies()`
output, so the reference always emits one of the three values. bowser emitting
`Lax` for an unspecified `sameSite` matches the reference exactly. Changing it
would manufacture an incompatibility in the one place the product exists to be
compatible. `normalizeSameSite` is correct as written and this spec does not
touch it.

## Objective

`bowser cookie-set` must never report success for a cookie the browser did not
store. A user or agent that reads `set <name>` and exit 0 must be able to rely
on the cookie existing.

Two changes, in dependency order:

1. **Reject an invalid `--same-site` before the request is sent**, the way the
   reference does, with a message naming the accepted values.
2. **Stop discarding CDP's `success`.** When the browser declines to store the
   cookie for any other reason, say so and exit non-zero.

Change 1 alone would fix the reported symptom and leave the defect. Change 2 is
the actual fix; change 1 exists because the reference validates client-side and
because a clear message beats a generic failure.

## Tech Stack

Bun 1.4.0, TypeScript 7.0.2. Zero runtime dependencies. No new devDependency.

## Commands

```
Typecheck (the real gate): bun run typecheck
Unit tests:                bun test
Chrome e2e:                BOWSER_E2E=1 BOWSER_BACKEND=chrome \
                             BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
                             bun test tests/e2e-cookie.test.ts
Reference contrast:        playwright-cli cookie-set <name> <value> --sameSite=<v>
```

macOS here has no `timeout`; wrap long commands as
`perl -e 'alarm 600; exec @ARGV or die' -- <command>`.

## Project Structure

Only files this spec touches:

```
src/commands/cookies.ts        → cmdCookieSet; the discarded success flag
src/cli/registry.ts            → cookie-set's Command entry (--same-site flag spec)
src/cli/parser.ts              → FlagSpec; where an enum flag would be declared
tests/cookie.test.ts           → unit tests over a fake client
tests/e2e-cookie.test.ts       → chrome-only end-to-end coverage
```

Untouched, deliberately: `src/commands/storage-state.ts`.

## Code Style

Match the surrounding file. `cmdCookieSet` today ends:

```ts
    await c.request("cookie-set", [param]);
    return reply(ctx, { ok: true }, `set ${name}`);
```

The shape after change 2 — read the result, fail loudly on failure, and keep
`reply()` as the single place that decides JSON versus text:

```ts
    const { success } = await c.request("cookie-set", [param]);
    // CDP declines a cookie it cannot store — a domain that does not match the
    // page, Secure without https. Reporting `set` for that is a lie the caller
    // cannot detect.
    if (!success) throw new Error(`cookie-set: browser refused to set ${name}`);
    return reply(ctx, { ok: true }, `set ${name}`);
```

Thrown errors already become a non-zero exit and a one-line message; see how
the other commands in this file signal failure.

## Testing Strategy

`bun test` with Bun's runner. Unit tests use the `fakeClient` factory in
`tests/helpers/fake-client.ts` — note the existing `cookie-set` fakes at
`tests/cookie.test.ts:178,195,207` already return `{ success: true }`, so they
keep passing unchanged, which is the evidence that today's happy path is
untouched.

Required coverage:

- Unit: a fake returning `{ success: false }` makes `cookie-set` fail rather
  than print `set <name>`. This test must fail against today's code.
- Unit: `--same-site=garbage` is rejected before any request reaches the client
  (assert the fake was never called).
- Unit: each of `Strict`, `Lax`, `None` is still accepted and still reaches the
  client in the `sameSite` field.
- E2E (chrome): `cookie-set` with an invalid `--same-site` exits non-zero, and
  `cookie-list` afterwards does not contain the cookie.
- Regression: a valid `cookie-set` → `cookie-list` → `state-save` round-trip
  still writes `sameSite` exactly as before, including `Lax` for a cookie set
  without the flag. This is what stops the cancelled second fix creeping back.

## Boundaries

- **Always:** run `bun run typecheck` and `bun test` before committing; check
  new behaviour against `playwright-cli` before deciding what is correct; keep
  `reply()` the only place that branches on `--json`.
- **Ask first:** widening scope to other commands that discard results;
  changing any message that is not `cookie-set`'s; touching
  `normalizeSameSite` or anything in `storage-state.ts`.
- **Never:** make `normalizeSameSite` distinguish absent from invalid — measured
  against the reference and rejected above; weaken a test to make it pass;
  report success for an operation whose result was not checked.

## Success Criteria

1. `bowser cookie-set k v --same-site=garbage` exits non-zero and prints a
   message naming the accepted values. Today it prints `set k` and exits 0.
2. `bowser cookie-set` exits non-zero when CDP returns `success: false` for any
   reason, with a message naming the cookie.
3. `cookie-list` after a failed `cookie-set` does not contain the cookie —
   verified end-to-end on chrome, not only against a fake.
4. Every existing test in `tests/cookie.test.ts` and `tests/e2e-cookie.test.ts`
   passes unchanged.
5. A cookie set without `--same-site` still round-trips through `state-save` as
   `"sameSite": "Lax"`, byte-identical to `playwright-cli`'s output.
6. `bun run typecheck` clean; `bun test` green; chrome e2e green.

## Open Questions — settled 2026-09-06

All three are decided; kept here with their reasoning.

1. **Error text.** Match `playwright-cli` closely —
   `'--same-site' option: Invalid option: expected one of "Strict"|"Lax"|"None"`
   — or use bowser's own phrasing? bowser uses kebab-case flags (`--same-site`
   vs `--sameSite`), so the strings cannot be identical anyway. **Decided: bowser phrasing, same information.**
2. **Where validation lives.** A one-off check inside `cmdCookieSet`, or a new
   `values?: string[]` on `FlagSpec` so any enum flag is validated by the parser
   and `--help` derives its placeholder from the same list? The second is more
   work and removes the hand-written `placeholder: "Lax|Strict|None"` that can
   drift from what is accepted. Only `--same-site` needs it today. **Decided: the `FlagSpec` route,
   because the drift it removes is the same class of bug as this ticket.**
3. **Scope.** `cookie-delete` and `cookie-clear` return `void`, so they cannot
   report failure at all — is auditing them part of this ticket or a separate
   one? **Decided: separate; this spec stays on `cookie-set`.**
