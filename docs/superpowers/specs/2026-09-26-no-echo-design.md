# Spec: `fill` and `type` never echo the text they entered

**Status:** approved 2026-09-26. The owner agreed ("Решение последовательное. Согласен").
**Origin:** exploratory testing of v0.6.0, session S5 (MCP). Through MCP, `fill` and `type` return the
text they entered, passwords included, so a secret lands in the agent's context twice. MCP has no
`--stdin` path to avoid this.

## Measured (2026-09-26)

- **bowser 0.6.0.**
  - `fill <ref> <text>` prints `filled e2 (textbox "Password")`, with no text.
  - `fill --json` prints `{"ok":true,"ref":"e2","text":"<text>"}`. The MCP tool returns this.
  - `fill --stdin --json` already omits `text`.
  - `type <text>` prints `typed "<text>"`, and `--json` gives `{"ok":true,"text":"<text>"}`.
- **`playwright-cli` 0.1.13.**
  - `fill` and `type` echo the text in the "Ran Playwright code" block.
  - Its `snapshot` shows a password field's value.
  - bowser already differs on purpose for the snapshot (#40), so neither line was byte-compatible before.

## Behaviour

1. **`fill`.** `fill --json` gives `{"ok":true,"ref":"<ref>"}` in every mode, the same shape `--stdin` already has. The plain-text output is unchanged.
2. **`type`.** `type` prints `typed N characters`, where N is the number of characters (code points), and `typed 1 character` when N is 1. `type --json` gives `{"ok":true,"length":N}`.
3. **MCP.** The MCP tools follow from 1 and 2 with no MCP-specific code.
4. **Other output.** bowser itself never echoes the entered text in either command's output or error messages; page content the command reports (dialog messages, which the page controls) is out of scope, as it is in `snapshot`.

## Acceptance

1. Unit tests through the command functions with `fakeClient` cover the plain and `--json` outputs of `fill` and `type`. They also check that the entered text appears nowhere in the output, error paths included, for example a stale ref.
2. An MCP unit test checks that the `fill` and `type` tool results do not contain the entered text.
3. README, SKILL.md and CHANGELOG (Unreleased) describe the new outputs, and `docs-drift` passes.
