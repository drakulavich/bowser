# `cookie-set` reports failure — implementation plan

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `bowser cookie-set` stops reporting success for a cookie the browser did not store.

**Spec:** `docs/superpowers/specs/2026-09-06-cookie-set-reports-failure-design.md` — read it first; it records what was measured against `playwright-cli` 0.1.13 and which half of the original ticket was cancelled.

**Approved decisions** (from the spec's Open Questions):
1. Validation lives in `FlagSpec`, as `values?: string[]`, so the parser rejects an unknown value and `--help` derives its placeholder from the same list.
2. Error text is bowser's own phrasing, not a copy of the reference's.
3. `cookie-delete` / `cookie-clear` are out of scope.

**Location note:** this plan is in `docs/superpowers/plans/` to match the repo's seven existing plans and what `CLAUDE.md` points at, rather than the skill's default `tasks/plan.md`.

## Global Constraints

- Zero runtime dependencies. Bun-native APIs only. No new devDependency.
- `bun run typecheck` (tsc) is the real gate: `bun test` strips types, so a type error does not fail the suite. Run both.
- Do not touch `src/commands/storage-state.ts`. `normalizeSameSite` folding an absent `sameSite` to `Lax` matches `playwright-cli` exactly and is correct.
- Every existing test passes unchanged. `tests/cookie.test.ts:178,195,207` already fake `{ success: true }`, so the happy path must stay green without edits.
- Commit messages end with the two attribution lines used across this repo.

---

### Task 1: an enum flag declares its values, and the parser enforces them

**Files:**
- Modify: `src/cli/parser.ts` (`FlagSpec`, `assignFlag`)
- Modify: `src/cli/help.ts` (`usageOf`)
- Modify: `src/cli/registry.ts` (cookie-set's `same-site` flag)
- Test: `tests/parse-args.test.ts`, `tests/help.test.ts`

**Interfaces:**
- Produces: `FlagSpec.values?: string[]`, enforced at parse time and rendered in `--help`.

- [ ] **Step 1: Write the failing tests**

In `tests/parse-args.test.ts`:

```ts
test("an enum flag rejects a value outside its list", () => {
  expect(() => parse(SCHEMAS, ["cookie-set", "k", "v", "--same-site=garbage"]))
    .toThrow("invalid --same-site: must be one of Strict, Lax, None");
});

test("an enum flag accepts each of its values", () => {
  for (const v of ["Strict", "Lax", "None"]) {
    const p = parse(SCHEMAS, ["cookie-set", "k", "v", `--same-site=${v}`]);
    expect(p.flags["same-site"]).toBe(v);
  }
});

test("a flag with no values list is unconstrained", () => {
  const p = parse(SCHEMAS, ["cookie-set", "k", "v", "--domain=anything.example"]);
  expect(p.flags.domain).toBe("anything.example");
});
```

In `tests/help.test.ts`, replace the existing `same-site` placeholder assertion:

```ts
test("an enum flag's usage lists the values the parser accepts", () => {
  expect(HELP).toContain("[--same-site=Strict|Lax|None]");
});
```

- [ ] **Step 2: Run them, see them fail**

Run: `bun test tests/parse-args.test.ts tests/help.test.ts`
Expected: the two new parse tests fail (no validation yet), and the help test fails because the hand-written placeholder still reads `Lax|Strict|None`.

- [ ] **Step 3: Add `values` to `FlagSpec`**

In `src/cli/parser.ts`, extend the interface. Keep `placeholder` — `--expires` still uses it:

```ts
  /** Accepted values for an enum flag. The parser rejects anything else, and
   *  `--help` derives the placeholder from this same list, so what is shown
   *  and what is accepted cannot drift. */
  values?: string[];
```

- [ ] **Step 4: Enforce it in one place**

`assignFlag` is reached from both the `--long` and `-short` branches, so validating there covers both without duplicating. Add at the top of the function, before the global-flag handling:

```ts
function assignFlag(out: Parsed, spec: FlagSpec, value: string | boolean): void {
  if (spec.values && typeof value === "string" && !spec.values.includes(value)) {
    throw new Error(`invalid --${spec.name}: must be one of ${spec.values.join(", ")}`);
  }
```

Note the message deliberately carries no command prefix, unlike the mock-up in the spec's question: `assignFlag` also validates global flags, which belong to no command, and a prefix that appears sometimes reads worse than one that never does. It matches the file's existing `unknown flag: --x` style.

- [ ] **Step 5: Derive the placeholder in `--help`**

In `src/cli/help.ts`, `usageOf` currently reads `f.placeholder ?? \`<${f.name}>\``. An explicit `placeholder` still wins; `values` is the next fallback:

```ts
    else parts.push(`[--${f.name}=${f.placeholder ?? f.values?.join("|") ?? `<${f.name}>`}]`);
```

- [ ] **Step 6: Declare the values on `cookie-set`**

In `src/cli/registry.ts`, the `same-site` flag drops its hand-written placeholder and gains the list. Order it `Strict, Lax, None` to match the reference's own message:

```ts
      { name: "same-site", kind: "string", values: ["Strict", "Lax", "None"] },
```

This changes `--help` from `[--same-site=Lax|Strict|None]` to `[--same-site=Strict|Lax|None]`. That is intended and goes in the CHANGELOG in Task 3.

- [ ] **Step 7: Run the tests, see them pass**

Run: `bun run typecheck && bun test`
Expected: green. Baseline before this task is 347 pass / 45 skip / 0 fail; the three new parse tests and the rewritten help test change the count.

- [ ] **Step 8: Commit**

```bash
git add src/cli/parser.ts src/cli/help.ts src/cli/registry.ts tests/parse-args.test.ts tests/help.test.ts
git commit -m "feat: an enum flag declares its values and the parser enforces them"
```

---

### Task 2: `cookie-set` stops discarding CDP's answer

**Files:**
- Modify: `src/commands/cookies.ts:105` (`cmdCookieSet`)
- Test: `tests/cookie.test.ts`

**Interfaces:**
- Consumes: the `cookie-set` op, already declared `result: { success: boolean }` in `src/daemon/protocol.ts:50`.

- [ ] **Step 1: Write the failing test**

In `tests/cookie.test.ts`, beside the existing `cookie-set` tests:

```ts
test("cookie-set fails when the browser refuses the cookie", async () => {
  // CDP answers { success: false } for a cookie it will not store — a domain
  // that does not match the page, Secure without https. Today this printed
  // "set nope" and exited 0.
  const c = fakeClient({ "cookie-set": () => ({ success: false }) });
  await expect(cmdCookieSet(ctx(c), "nope", "v")).rejects.toThrow(
    "cookie-set: browser refused to set nope",
  );
});
```

Match the surrounding tests' way of building `ctx` and `fakeClient` — copy the shape from the `cookie-set` test at `tests/cookie.test.ts:178` rather than inventing one.

- [ ] **Step 2: Run it, see it fail**

Run: `bun test tests/cookie.test.ts`
Expected: fails because `cmdCookieSet` resolves with `set nope` instead of rejecting. **This failure is the whole point of the ticket — confirm you see it before fixing.**

- [ ] **Step 3: Read the result**

In `src/commands/cookies.ts`, replace the two lines at the end of `cmdCookieSet`:

```ts
    const { success } = await c.request("cookie-set", [param]);
    // CDP declines a cookie it cannot store. Reporting `set` for that is a lie
    // the caller cannot detect: this printed success while cookie-list stayed
    // empty (see the 2026-09-06 spec).
    if (!success) throw new Error(`cookie-set: browser refused to set ${name}`);
    return reply(ctx, { ok: true }, `set ${name}`);
```

- [ ] **Step 4: Run the tests, see them pass**

Run: `bun run typecheck && bun test`
Expected: green, including the three pre-existing `cookie-set` tests that fake `{ success: true }` and must not need edits.

- [ ] **Step 5: Commit**

```bash
git add src/commands/cookies.ts tests/cookie.test.ts
git commit -m "fix: cookie-set says so when the browser refuses the cookie"
```

---

### Task 3: end-to-end proof, docs, gate, PR

**Files:**
- Modify: `tests/e2e-cookie.test.ts`, `CHANGELOG.md`

- [ ] **Step 1: The end-to-end test**

A fake proves the branch; only a real browser proves the premise. Add to `tests/e2e-cookie.test.ts`, copying that file's existing guard rather than writing a new one:

```ts
test("an invalid --same-site is refused and no cookie is created", async () => {
  const bad = await runCli(["-s", session, "cookie-set", "k", "v", "--same-site=garbage"]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr + bad.stdout).toContain("must be one of");

  const list = await runCli(["-s", session, "cookie-list", "--json"]);
  expect(JSON.parse(list.stdout)).not.toContainEqual(expect.objectContaining({ name: "k" }));
});

test("a cookie set without --same-site still round-trips as Lax", async () => {
  // Guards the half of the original ticket that measurement cancelled:
  // playwright-cli writes Lax here too, so this must not change.
  await runCli(["-s", session, "cookie-set", "plain", "v1", "--domain=localhost", "--path=/"]);
  const file = join(tmpdir(), `state-${Date.now()}.json`);
  await runCli(["-s", session, "state-save", file]);
  const state = JSON.parse(readFileSync(file, "utf8"));
  expect(state.cookies).toContainEqual(expect.objectContaining({ name: "plain", sameSite: "Lax" }));
});
```

Adapt `runCli`/`session` to whatever that file already provides. If it has no helper for reading an exit code, use the one the other e2e suites use rather than adding a new one.

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Fixed`:

```markdown
- **`cookie-set` reported success for a cookie the browser refused.** CDP answers
  `Network.setCookie` with whether the cookie was stored and the result was discarded, so
  `cookie-set` printed `set <name>` and exited 0 even when nothing was created — an invalid
  `--same-site` was one way to reach it. The result is now checked, and an unknown `--same-site`
  is rejected before the request is sent, as `playwright-cli` does.
```

And under `### Changed`:

```markdown
- **An enum flag declares its accepted values.** `FlagSpec.values` drives both parser validation
  and the `--help` placeholder, so the two cannot drift. `bowser --help` now shows
  `[--same-site=Strict|Lax|None]`, previously `[--same-site=Lax|Strict|None]`.
```

- [ ] **Step 3: Full gate**

```bash
bun run typecheck && bun test
BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test
BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts tests/e2e-dialog.test.ts
```

Wrap the e2e commands in `perl -e 'alarm 900; exec @ARGV or die' --`; macOS here has no `timeout`. If anything fails, stop and report rather than pushing.

- [ ] **Step 4: Contrast against the reference one last time**

```bash
playwright-cli cookie-set k v --domain=localhost --path=/ --sameSite=garbage   # errors
bowser        cookie-set k v --domain=localhost --path=/ --same-site=garbage   # must now error too
```

Record both outputs in the PR body. This is the evidence that the fix closed the gap the spec measured.

- [ ] **Step 5: Push and open the PR**

Body covers: the discarded `success` flag as the real cause; that an invalid `--same-site` was one symptom; that `normalizeSameSite` was measured against `playwright-cli` and deliberately left alone; and the `--help` ordering change. End with the repo's standard attribution block.

---

## Self-review against the spec

- **Success criterion 1** (invalid `--same-site` exits non-zero with the accepted values named) → Task 1, Steps 4 and 6; proven end-to-end in Task 3.
- **Criterion 2** (non-zero when CDP returns `success: false`) → Task 2.
- **Criterion 3** (`cookie-list` does not contain the cookie afterwards) → Task 3, Step 1, first test.
- **Criterion 4** (existing tests pass unchanged) → the three `{ success: true }` fakes are untouched by design; Task 1 Step 7 and Task 2 Step 4 both run the full suite.
- **Criterion 5** (`Lax` round-trip byte-identical to the reference) → Task 3, Step 1, second test, which exists specifically to stop the cancelled fix creeping back.
- **Criterion 6** (typecheck, tests, chrome e2e) → Task 3, Step 3.
- **Boundaries honoured:** `storage-state.ts` is in no task's file list; scope stays on `cookie-set`.
