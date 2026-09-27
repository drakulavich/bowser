# CLAUDE.md

If something in this repo surprises or confuses you, say so where the next reader will see it: in the PR, in your report, or in a code comment at the spot. If the next agent would fall into the same trap, also add a line here.

Every line below traces to a real failure that no test or type check catches. When code or a test makes a line unnecessary, delete the line.

## Checking a change

- `bun test` skips every browser test and does not type-check. Before calling a daemon, browser or page-script change done, also run `bun run typecheck` and `BOWSER_E2E=1 bun test`. (PR #23, PR #46)

## Code traps

- Write to a socket only through `socketWriteAll()`. A raw `socket.write` silently drops whatever the buffer can't take (about 8 KB). (#9)
- A ref command acts on `liveSelector(c, ref)`, never on the saved `target.selector`, which can time out or hit a different element. (#37)
- The snapshot walker never reads a password field's value. Route any new `el.value` read through `isPassword`. (#40)
- An action that can navigate runs inside `nav.act()`. Otherwise the next `state` or `snapshot` reports the old page. (#7, F10 in PR #46)
- Resolve a path under `$HOME` inside the function, not at module load. Tests redirect `HOME` in `beforeAll`, and a module-level path made them write to the real `~/.bowser`. (PR #8)

## Git

- If a push that changes `.github/workflows/` is refused for a missing `workflow` scope, run `gh auth setup-git`. (ed1d6b1)
- A squash-merge of a branch cut from local commits on `main` leaves local `main` diverged. Fix it with `git reset --hard origin/main`, not a merge. (ed1d6b1)
