# Exploratory-testing session log: building a cart on carrefouruae.com

**Campaign goal:** find out how well bowser lets an agent build a shopping cart on a real, heavy, client-rendered shop. The target is `main` at 73de687 (0.10.1 plus #108 and #110). The shop is `https://www.carrefouruae.com/mafuae/en`; `carrefour.ae` does not resolve.

**Product context:**
- **Domain:** a CLI and MCP server that AI agents use to drive headless WebKit.
- **Users:** coding agents running the `snapshot → ref action → snapshot` loop.
- **Risks that matter:** an action that lands on the wrong element, a hang that eats the budget, a lost session, a report that says something other than what happened, a password in the output.

**The site:** a Next.js app behind Akamai. Product pages, search and filters are client-side routes inside one document. Every product card has a button named "Add to cart"; after a click the site swaps it for a `- qty +` stepper.

**Ground rules:**
- Isolated temp `HOME`; the real `~/.bowser` was never touched.
- A real account. Email and password went from 1Password straight into `bowser fill --stdin` and never reached argv or the logs.
- No checkout, no payment, no change to the address or profile. Human pace.
- The cart was emptied at the end of every session; it was empty at the start.
- Screenshots stayed in the scratch directory, because they show the account email.
- The runner `b.sh` and the MCP client `mcp.ts` lived in the scratch directory and are not in the repo.

## Status legend

- `observation`: seen once; may be intentional.
- `confirmed`: reproducible defect, filed.
- `closed`: intentional, not bowser's, or a false alarm; the rationale is kept.

## S1. Money tour: sign in, search, five products, cart (CLI)

**Charter:** explore the path from sign-in to a five-item cart through the CLI, to find whether an agent reaches the cart without workarounds and whether the cart matches the product cards. Negative tour: Couch Potato, accepting every default. About 35 min.

What worked:
- A ref used before any snapshot is refused with exit 1.
- Sign-in: email, then "Use Password Instead" past the emailed code, then the password through `fill --stdin`. Grepping the snapshot for the password found 0 matches.
- After `close` and `open --persistent` the account was still signed in.
- `goto /search?keyword=<q>` and a click on "Add to cart" added milk, bread, eggs, bananas and rice in 0.2 s each. The subtotal, AED 45.19, equals the sum of the card prices.
- The "Are you sure?" dialog for "Delete All" is the only thing in the snapshot while it is open.

Findings:
- **ET-C1, confirmed, #112.** After `fill` and `press Enter` in the search box, the suggestions stay open over a full-page backdrop (`div.fixed.inset-0.z-10.bg-black/30`). `elementFromPoint` at an "Add to cart" button returns the backdrop. `click` on the button hung until the budget: `'click' timed out after 30000ms`, exit 2. With `BOWSER_OP_TIMEOUT_MS=5000` the next command answered `session is stuck: 'click' is still running after a reload; run 'bowser close'`. Reproduced twice.
- **ET-C2, observation, #113.** After "Continue" on the email form, a screenshot showed Akamai's "Processing your request" box with a countdown over the whole page, while `snapshot` listed the form as if nothing covered it. Not reproduced on purpose.
- **ET-C3, confirmed, #114.** `click` on the "Login & Register" link answered in 0.1 s, and a snapshot straight after still showed the home page; the route changed a second or two later. In S3 a click on a search suggestion took over 3 s to change the URL. bowser has no command to wait for that.
- **Closed:** cart prices looked like `".49"` in a grep. The whole part sits in a sibling node (`"12"`, `".49"`, `AED`); the snapshot is fine.

## S2. Landmark and Interfaces, with Obsessive-Compulsive

**Charter:** explore search, filters, the cart's quantity controls and the delivery-mode switch, repeating actions, to find whether refs survive client-side re-renders and whether bowser reports what it did. About 25 min.

What worked:
- The brand filter changes the URL with `replaceState` and re-renders the list. An old ref then answers "not found", not "page no longer loaded", which is right for the same document (#108).
- The subtotal matched the lines (AED 83.92).
- Switching delivery to NOW kept the Scheduled cart.

Findings:
- **ET-C4, confirmed, #112.** Two back-to-back `click`s on one "Add to cart" both answered `clicked eN (button "Add to cart")`, and the quantity became 2: 4 of 4 products. With 1 s between them the second was refused and the quantity stayed 1: 2 of 2. The old button stays in the DOM for under a second after the site swaps it for the stepper, so the ref resolves, and the native click at its coordinates lands on "Increase quantity". Same root as ET-C1: no hit test before the click.
- **Closed, the site's:** the cart's quantity buttons have no name; the snapshot shows `button [ref]`, `combobox "2"`, `button [ref]`, and an agent can't tell minus from plus.

## S3. Bad Neighborhood

**Charter:** explore the places of bowser's past bugs (stale refs, `go-back`, `reload`, `select`, keys, large replies) on the real site, to find which closed bugs come back. About 20 min.

All passed:
- Product pages are client-side routes in one document. After `go-back`, a ref from the product page answers "not found".
- After `reload` (with a pause), an old ref answers `ref 'e352' is from a page that is no longer loaded; take a new snapshot` (#108).
- `select` on the cart's custom quantity combobox is refused with `ref 'e174' is not a <select> element (combobox)`, exit 1. Clicking the combobox and then `option "3"` works; the subtotal became 20.97 = 3 × 6.99.
- `type`, `press ArrowDown` and `press Escape` work. The site's backdrop does not close on Escape.
- `eval` of the page's 1.3 MB HTML came back whole in 0.1 s (#63).

Not covered: the pending-navigation paths (ET-10, #111), because every navigation on this site is client-side; and ET-C2, because reproducing it means signing out and in again.

## S4. Rained-Out and Saboteur

**Charter:** explore killing, closing and starving commands in the middle of adding to the cart, to find whether the cart stays consistent and bowser says what was delivered. About 15 min.

What worked:
- Three parallel `click`s on three products ran one after another (0.2, 0.4, 0.5 s); the cart had 3 items (#77).
- `kill -9` of the daemon 80 ms after a click: the click answered `daemon for session 'cf' closed the connection`, exit 2; the next command said `run 'bowser open --persistent'` (#90). After reopening, the account was signed in and the click had not reached the site.
- `close` in the middle of `goto` closed the session in 1.1 s and left no daemon.

Findings:
- **ET-C5, confirmed, #115.** `BOWSER_OP_TIMEOUT_MS=50 click <Add to cart>` answered `'click' timed out after 50ms`, exit 2, yet the product was added: the cart went 3→4, 4→5, 5→6. Recovery then reloaded the page, so old refs answered "page no longer loaded" and the cart counter read 0 for a few seconds. An agent that retries adds the product twice.
- **Closed:** "closed the connection" does not say whether the session was closed or the daemon died. Not worth an issue on its own.

## S5. Comparable: the same cart through `bowser mcp`

**Charter:** explore building the cart through the MCP server as an agent would, to find where MCP serves the agent worse than the CLI. A fresh, signed-out profile. About 15 min.

What worked:
- `tools/list` returns 34 tools, each with a `session` argument.
- A bad ref, a malformed ref, a missing argument and an unknown tool all come back as `isError` with the same text as the CLI.
- A guest cart works.

Findings:
- **ET-C6, confirmed, #116.** `reload` answers after 0.1 s while the page is still reloading. A `goto` straight after fails with WebKit's raw `The operation couldn’t be completed. (NSURLErrorDomain error -999.)`, exit 2: 3 of 3 on the shop through the CLI and through MCP, 0 of 3 on example.com. A ref used right after `reload` answered "not found" instead of "page no longer loaded".
- **ET-C7, confirmed, #117.** The MCP `click` result is `{"ok":true,"ref":"e724","url":…}` with no element description; the CLI prints `clicked e724 (button "Add to cart")`.
- ET-C4 again: two parallel MCP `click`s on one button gave a quantity of 2.
- **Closed:** the MCP snapshot is a JSON string, so newlines and quotes are escaped (+2 KB on 71 KB). It is structured on purpose.

## Debrief

Five sessions, about 110 minutes, all on the live site. The agent could build a cart every time, but three defects make that unsafe without care:

1. **#112:** bowser clicks at coordinates without checking what is there. On an overlay it hangs and can lose the session; on a button the site has just swapped it presses the replacement and reports the original. A hit test in the request that resolves the ref covers both.
2. **#115:** a timed-out action may have been delivered, and the message does not say so.
3. **#116:** `reload` returns early, and the next navigation fails with a raw WebKit error.

Smaller: #113 (a covered page looks normal in the snapshot), #114 (no way to wait for a client-side route), #117 (MCP results don't name the element).

Next: fix #112 first; then #115 and #116.
