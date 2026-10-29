# Errors, timeouts and upgrades

## Error messages

- **"ref 'eN' not found in the current page snapshot"**: the element behind the ref is gone (the page re-rendered, navigated or reloaded since that snapshot). Run `bowser snapshot` and use the new refs.
- **"ref 'eN' not found in last snapshot"**: the ref was never in the last snapshot. Run `bowser snapshot`.
- **"ref 'eN' is from a page that is no longer loaded; take a new snapshot"**: the ref is from before a navigation or reload, or from the page `go-back` left. Snapshot again.
- **"ref 'eN' now points to …; take a new snapshot"**: the element behind the ref now has another role or name (a button relabelled itself); nothing was done. Run `bowser snapshot` and pick the ref you mean.
- **"'f1e3' is a playwright-cli frame ref"**: bowser does not snapshot iframe contents, so it has no frame refs. Click the iframe's own ref, then use `press` or `type`.
- **"ref 'eN' is not a checkbox or radio button"** (or `<select>`, or `<input>`…): the ref is the wrong kind for `check`/`uncheck`/`select`/`fill`, e.g. the listitem around a checkbox. Use the control's own ref from the snapshot.
- **"ref 'eN' has no option \"…\""**: `select` found no option with that value or label. Read the options in the snapshot and pass one of them.
- **"ref 'eN' is not an editable element (disabled)"** or `(readonly)`: the page does not let that field be edited now; enable it first (e.g. fill the field that unlocks it) or pick another.
- **"ref 'eN' (…) is covered by … at its click point"**: `click` or `fill` found another element on top of the ref's centre: a backdrop, a dialog, or a control the page swapped in (a `+` stepper where "Add to cart" was); nothing was clicked. Close what covers it, or take a new snapshot and use the ref of what is there now.
- **"ref 'eN' is disabled"**: `click`, `check` or `uncheck` on an element the page has disabled (`[disabled]` in the snapshot); nothing was clicked. Do what enables it first, then act again.
- **"ref 'eN' is a radio button; select another option in its group to uncheck it"**: a radio cannot be unchecked on its own: `check` another radio in its group.
- **"did not accept the value for input[type=date]"** or **"needs a number"**: use the input's own format: `YYYY-MM-DD` for `date`, `HH:MM` for `time`, `#rrggbb` (lowercase) for `color`, digits for `number`.
- **"run-code runs JavaScript in the page and has no Playwright 'page'"**: you passed a `playwright-cli` snippet (`async page => …`). Write page JavaScript instead: statements with `return`, e.g. `bowser run-code "return document.title"`.
- **"no open page"**: call `bowser open <url>` first.
- **Click times out**: element not actionable (animating, or covered only after the ref was resolved). Re-snapshot.
- **"session '<name>' is not open (its browser exited)"**: the session's browser crashed or was killed; its page and refs are gone. Run `bowser open <url>` (add `--persistent` again for a persistent session) to start it anew, or `bowser close` to clear it. Only `open` and `close` work on such a session.
- **"the page dropped the call before it answered"** (exit 2): either `eval` or `run-code` returned a promise nothing resolves and the page dropped it, or the page navigated or reloaded while the command ran (a recovery reload does this to a `fill`, for one). Return a value, or a promise that resolves; otherwise run `bowser snapshot` to see where the page is. If the page keeps a promise that never settles, the command times out instead.
- **"the page crashed (its web process exited)"**: the page's web process died twice, and WebKit no longer reloads it (exit 2). Run `bowser reload`, or `bowser goto <url>`, then snapshot again. The first crash is not reported: WebKit reloads the page, which looks like the page reloading itself, so page state is gone and old refs fail with `not found in the current page snapshot`.

## Timeouts

`BOWSER_OP_TIMEOUT_MS` is the per-command timeout in ms (default `30000`; `0` disables). It covers the whole command, all its steps and any time spent waiting behind another command. The daemon reads it once, when the session starts; a value set on a later command applies only when it is smaller, so to raise it, `bowser close` and `bowser open` again with the new value. An upgrade restart keeps it, and the first command after an upgrade can take up to twice the budget.

- A timeout names the command and the step that overran, e.g. `'fill' timed out after 3000ms (in its 'click' step)`.
- `the click was delivered, check the page before retrying` means the action happened, and `the click may have been delivered` means it may have: run `bowser snapshot` before you retry, or you may act twice.
- If a timed-out command is still running 2 s later (or after the budget, if that is under 2 s), the daemon reloads the page once to free the browser. If the command outlives the reload, every command fails at once with `session is stuck: '<cmd>' is still running after a reload; run 'bowser close'` until it ends: run `bowser close` and reopen. A command sent while that reload runs waits for it, so the first such failure can take up to 12 s (22 s in a session that has not loaded a page yet). A command whose client was killed is treated as timed out 5 s after its connection closes, even with `BOWSER_OP_TIMEOUT_MS=0`. On a page whose first load `open` had to stop (see `open`/`goto`), the recovery reload leaves the page for `about:blank` instead; `goto` it again.
- `page is still loading <url>; retry later, or run 'bowser close'` means an earlier command's navigation never finished; retry after a while, or close.
- If the daemon itself stops answering, the command fails 2 s after its budget with `daemon for session '<s>' did not answer; run 'bowser close -s <s>' to stop it` (exit 2): run `bowser close -s <s>`, then open the session again.

## Install and upgrades

The package runs with the `bun` on your `PATH`. npm does not enforce the Bun version, so on an older Bun a command that would start a session fails with the error "bowser requires Bun >=1.4.4 (found <version>)". Release binaries are no longer built: if you used one, run `bowser close --all` with it, delete it, then `npm i -g @drakulavich/bowser-cli`.

After an upgrade, the first command restarts the session and prints "session '<name>' restarted for bowser <w> (was <v>): …; refs cleared, run 'bowser snapshot'" first (on stderr, or first in the MCP tool text). Take a new snapshot before using refs. Without `--persistent` or `--profile` the line adds "cookies and storage were lost": log in again. The restart has its own budget, so that first command can take up to twice the budget. "is being restarted by pid N …; retry in a moment" means another command is restarting it: retry.

bowser runs on macOS only: it drives WebKit, which `Bun.WebView` provides only there. Elsewhere a command that would start a session fails with the error "bowser requires macOS (WebKit)". If you need Chromium, or Linux or Windows, use `playwright-cli`.
