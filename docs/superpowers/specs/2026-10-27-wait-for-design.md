# wait-for: wait until the URL or the text an action leads to is there (#114)

## Problem

On a client-side app an action's result often arrives after the command that caused it has answered. In the
2026-10-02 session on carrefouruae.com (a Next.js app), `click` on "Login & Register" answered in 0.1 s; the
route changed to `/login/phone` about a second later, by `pushState` after a fetch, past the 100 ms window in
which `click` waits for a navigation to begin. A `snapshot` right after the click still showed the home page.
bowser has no way to wait for that: an agent sleeps, or polls with `eval`. The same gap shows on any page that
renders text after a fetch.

`playwright-cli` 0.1.13 has no wait command (`playwright-cli --help`). Playwright MCP has `browser_wait_for`
(text, textGone, time), so the name `wait-for` is the one agents already know.

## Change

### The command

```
bowser wait-for --url <part>     # until location.href contains <part>
bowser wait-for --text <text>    # until the page's visible text (document.body.innerText) contains <text>
```

Exactly one of the two flags, with a value that is not empty; both, neither, or an empty value is a usage error
(exit 1): `includes("")` would match every page (Grok's Optional #296, taken on approval). The match is a plain substring,
case-sensitive: `--url /login` matches `https://www.carrefouruae.com/mafuae/en/login/phone`.

On success it prints the page's URL (`--json`: `{ "ok": true, "url": "…" }`) and saves it to the session
state, as `click` does, so a later ref command sees the page it is on. When the condition is already true it
answers at once.

The wait is bounded by the command's budget: the one the daemon started with (`BOWSER_OP_TIMEOUT_MS`, default
30 s), or a smaller one set on the command, as for every command. When it runs out:

```
wait-for: no URL containing '/login' after 30000ms; the page is at https://www.carrefouruae.com/mafuae/en/
wait-for: no text "Order placed" after 30000ms; the page is at https://shop.example/checkout
```

exit 2, as other timeouts. `BOWSER_OP_TIMEOUT_MS=0` on the command does not lift the daemon's budget (the
client then sends none, and the daemon applies its own); only a session opened with `0` waits until the
condition holds.

### Where the loop runs

A new daemon op, `waitFor` (`args: [kind: "url" | "text", value: string]`, result `{ met: boolean; url: string; title: string }`),
loops in the daemon: evaluate the check, and when it is false wait 100 ms and evaluate again.

- **The check** is `waitForScript(kind, value)` in `src/page-scripts.ts`, which puts the value in the script
  with `JSON.stringify`, never by concatenation: `--text "it's there"` must match, and no value can break out
  of the string.
- **The deadline.** `createHandler`'s `handle` sends `waitFor` down the same path as `resolve`: through
  `afterPendingNavigation(req, deadline)`, which waits out a navigation an earlier command left pending (so a
  read never answers from the document about to go) and hands the op the `deadline` `dispatch` computes, 50 ms
  before the request's timer. The op's handler takes that deadline as an argument; with no budget it is
  `undefined` and means no end.
- **The wait between reads** is `min(100 ms, deadline - now)`. When the deadline has passed after a read, the op
  answers `{ met: false, url, title }` (`realUrl`, `realTitle`), so the command prints its own message. On
  success the op answers the same shape, and the command saves `url` and `title` with `syncState`: no separate
  `state` request, which near the deadline would have no budget left (Grok's FYI #298).
- **One read at a time.** The next evaluate starts only after the previous one settled. A read is not raced
  against the deadline: one that does not settle holds the op, the request's timer fires, and the client gets
  the generic `'wait-for' timed out after …` while the daemon recovers the page, as for any wedged evaluate.
  Returning early instead would leave that read in `wrapView`'s queue, and the next command's evaluates would
  wait behind it with no recovery.
- A read that throws (the document is being replaced) counts as "not yet".

It is not in `ACTS`: it does not act on the page.

```mermaid
sequenceDiagram
  participant CLI as bowser wait-for
  participant D as daemon (waitFor op)
  participant P as page
  CLI->>D: waitFor ["url", "/login"]
  loop until met or deadline
    D->>P: waitForScript("url", "/login")
    P-->>D: false
    Note over D: 100 ms
  end
  P-->>D: true
  D-->>CLI: { met: true, url, title }
  Note over CLI: save url and title to state
```

A loop in the CLI (one `evaluate` request per check) was the alternative. Each request would carry the budget
left, and the last one would fail with the daemon's `'wait-for' timed out … (in its 'evaluate' step)`, which
does not say what was awaited. It also costs a socket round trip per check.

Because the loop is a daemon op, `bowser mcp` gets a `wait-for` tool from the command registry with no MCP
code.

## Cost

No stored data changes. While waiting, one `evaluate` per 100 ms plus the time the read takes: up to 300 reads
in a 30 s budget, each a `String.includes` over `location.href` or `document.body.innerText`. `innerText`
forces a layout, so on a very large page (the 2 MB ECMAScript spec of ET-53) each read costs that layout; not
measured, since no case waits for text on such a page.

## Not in scope

- `--text-gone`, `--time`, a ref or a selector, regular expressions: no case asked for them yet.
- `snapshot` waiting for the page to settle (the issue's other option): it would change every snapshot's timing
  to fix the case `wait-for` covers.
- Text inside iframes or shadow roots (`innerText` does not cross them).

## Definition of Done

- `tests/daemon-handler.test.ts`, driving `createHandler(...).handle(req, deadline)` with a fake browser (not the
  op function alone, so the deadline's path through `handle` is under test):
  - a check that turns true on the third read answers `{ met: true, url }` after two 100 ms waits;
  - a check that never turns true answers `{ met: false, url }` by the deadline, not after it;
  - with no deadline, the op is still reading past 1 s;
  - a read that throws counts as "not yet";
  - a read that does not settle: no second read is sent, and the op has not answered at the deadline;
  - with `navigationPending` true, the first read comes after the pending navigation lands;
  - the value `it's "there"` reaches the page as that string.
- `tests/commands.test.ts`, with a fake client: `wait-for` with both flags or neither exits 1 with a usage line;
  `{ met: false }` gives the message above, exit 2; `{ met: true }` prints the URL and saves it to state.
- `tests/e2e-actions.test.ts` (or a new e2e file), on a fixture page whose button does `pushState('/moved')`
  after 1 s and adds the text "Moved" after 1.5 s: `click` then `wait-for --url /moved` prints `<base>/moved`
  within 3 s; `wait-for --text Moved` answers; with `BOWSER_OP_TIMEOUT_MS=1500`, `wait-for --text Never` exits 2
  with the message above within 2.5 s. Today: `bun src/cli.ts wait-for --url /x` exits 1 with
  `bowser: unknown command: wait-for`.
- `docs-drift` passes (it checks the README command table and `skills/bowser/SKILL.md`);
  `skills/bowser/references/commands.md` gets a `wait-for` row by hand, which docs-drift does not check.
- Each new test goes red under one mutation of the line it names, quoted in the PR.
