# Spec: `snapshot` never reveals a password field's value

**Status:** approved (owner decision 2026-09-26: "Hide it", after the `fill --stdin` review found the
leak). Follows `fill <ref> --stdin` (PR #39), whose purpose — a 1Password secret never reaching argv
or output — this completes.

## Problem

After `op read … | bowser fill e3 --stdin`, the next `snapshot` prints

```
- textbox "Password" [active] [ref=e3]: hunter2-TOPSECRET
```

(plain and `--json`, both backends; `playwright-cli` 0.1.13 prints the same), and `state.json` stores
up to 120 characters of it as the ref's `value`. The walker in `src/page-scripts.ts` also reads
`el.value` when computing names: an element named through `aria-labelledby` that references a
password input, or a textbox whose name falls back to its value, would carry the secret into another
line.

## Behaviour

1. For `<input type="password">` (case-insensitive `type`), the walker never reads `el.value` into
   anything it returns: no value child (the node prints as a leaf or with its props only, e.g.
   `- textbox "Password" [ref=e3]` or with `/placeholder`), no `value` in the saved ref, and no
   contribution to any accessible name (an `aria-labelledby` reference to it adds nothing; its own
   name never falls back to its value).
2. Everything else about the node is unchanged: role `textbox`, name from its label/`aria-label`/
   `placeholder`, attributes, ref, props.
3. Other inputs keep today's behaviour, including `type="text"` fields that happen to hold secrets
   (bowser cannot know).
4. This is a deliberate difference from `playwright-cli`; CHANGELOG and README say so.
5. A password field's value can still be read with `eval` on purpose; out of scope.

## Acceptance (public seams only)

1. E2E on WebKit and Chromium: a page with a labelled password input, a text input, and a button
   whose `aria-labelledby` references the password input. After `fill` of a known secret into the
   password field (both `fill <ref> <text>` and `fill <ref> --stdin`): `snapshot` plain and `--json`
   contain no occurrence of the secret; the password line is exactly the expected leaf line; the text
   input still shows its value; `state.json` in the temp HOME contains no occurrence of the secret.
2. The existing goldens stay byte-identical (no fixture has a filled password field); if one changes,
   stop and report.
3. Docs: README and SKILL.md one line each ("password field values are never shown"); CHANGELOG
   entry under `## [Unreleased]`; CLAUDE.md snapshot convention gets one clause.

## Out of scope

Heuristics for secret-looking text inputs; `autocomplete="current-password"` on non-password inputs;
redacting `eval`/`run-code` output.
