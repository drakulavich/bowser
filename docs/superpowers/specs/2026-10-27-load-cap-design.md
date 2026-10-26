# open and goto stop waiting for `load` 5 s after the page is parsed (ET-52, #155)

## Problem

`open <url>` and `goto <url>` resolve when WebKit fires `load`. A subresource that never finishes (an image,
a font, a tracking script) holds `load` back for good, so the command waits out its budget even though the
page's text has been there since DOMContentLoaded. In the 2026-10-14 campaign `open https://www.bbc.com/news`
timed out after 30 s in 3 of 4 runs, and the session then answered every command with
`session is stuck: 'open' is still running after a reload`. A local page whose `<img>` never answers
reproduces the `open` half: `'goto' timed out … (in its 'navigate' step)`, with `readyState` `interactive` and
the text on screen.

Two measurements on a bare `Bun.WebView` (Bun 1.4.4, a page with `<h1>` and an `<img>` whose server never
answers):

- During the load, `evaluate` answers at once: the new document reports `readyState` `interactive` about 360 ms
  in, while `navigate()` stays pending and `view.url` stays `""`.
- `evaluate("window.stop()")` ends the load: `navigate()` rejects with NSURLErrorDomain -999 about 20 ms later,
  `onNavigationFailed` fires, `view.loading` turns false, and a following `navigate()` works. Without the stop
  that following `navigate()` throws `ERR_INVALID_STATE: a navigation is already pending`, so the command
  cannot simply return early and leave the load running.

After the stop `view.url` and `view.title` stay `""` (they change only on a completed navigation);
`location.href` and `document.title` are right. bowser already reads both through `evaluate` (`realUrl`,
`realTitle`).

## Change

### The cap

`navigationWatch.navigate` (`src/browser.ts`) runs a watcher next to `go()`:

1. Before `go()`, read `performance.timeOrigin` of the current document (`ask`, bounded by `graceMs`). If
   that read gives no number, there is no baseline to compare with, and the watcher does not run: the
   navigation waits for `load` as today.
2. Read `[performance.timeOrigin, document.readyState]`, one read at a time: the next read starts 100 ms
   after the previous one settled, never while one is still in `wrapView`'s evaluate queue. A new document is
   one whose `timeOrigin` differs from step 1, so the same URL (a `goto` to the page already open) and a
   redirect both count.
3. Once a new document reports anything but `loading`, wait `LOAD_CAP_MS` (5000) more for `go()`. If a later
   read shows yet another `timeOrigin` (a document that navigated on), the 5 s start again from it.
4. If `go()` is still pending, `evaluate("window.stop()")`, and mark the navigation stopped.

`go()` settling (resolved or rejected) ends the watcher at any step. When the navigation was stopped and
`go()` rejects with -999, `navigate` checks `view.loading`. False: the -999 was the stop's own, and
`navigate` returns as if the page had loaded, so the command answers with the page's URL and title. True: a
page script started another navigation that the stop did not cover, and `navigate` takes the existing #116
path (wait for the next landing).

```mermaid
sequenceDiagram
  participant C as navigate()
  participant V as WebView
  participant P as new document
  C->>V: navigate(url)
  loop every 100 ms
    C->>P: [timeOrigin, readyState]
  end
  P-->>C: new timeOrigin, "interactive"
  Note over C: wait up to 5 s for load
  C->>P: window.stop()
  V-->>C: navigate rejects -999 (our stop)
  C-->>C: return: the page is there
```

A page that loads within the cap is untouched: no stop, the same `load` wait as today, plus the reads of step
2. A document that never reaches `interactive` (a server that never answers, the F9 case) is not stopped
either: the budget and the recovery reload handle it as today. A page whose `evaluate` does not answer while it
loads (the BBC wedge, unexplained) reads as "no new document yet", so it also behaves as today, with one difference: a single read stays in the
evaluate queue, so a recovery's `LEAVE_INITIAL_DOCUMENT` there is refused and `interrupt()` takes its existing
fallback, `navigate("about:blank")` (#67).

5 s matches the fixed cap `markdown` gives a Markdown alternate (ET-61, #204). It is not tied to the budget: a
budget shorter than DOMContentLoaded plus 5 s times out as today.

### Recovery after a stopped load

`interrupt()` takes `view.url === ""` to mean "nothing has committed yet" and leaves the document with
`location.replace('about:blank')` (#48), because `reload()` does nothing then. After a stopped first load
`view.url` is still `""`, so a later recovery on that page (an op that timed out on it) leaves it for
`about:blank`, as on a fresh session. That is unchanged code and an edge of an edge; it is documented, not
fixed: the next `goto` or `open` loads the page again.

### Docs

The README `open` and `goto` rows, and the `open`/`goto` lines in `skills/bowser/references/commands.md`: the
command waits for the page's `load` event, and when the page is parsed but `load` has not come 5 s later, it
stops the loads still running (images, frames, scripts) and answers with the page as it is.

## Cost

No stored data changes: one per-navigation flag (`stopped`) in memory. The reads of step 2 are at most one
`evaluate` per 100 ms while a navigation is in flight, and never two queued: about 10 for a page that loads
in 1 s. On a stopped page, images and frames that had not finished stay missing (a `screenshot` shows
them broken), which is the trade for the command answering at all.

## Not in scope

- The BBC wedge (no `evaluate` answers during that load, CPU idle): needs a look at Bun.WebView first.
- `click` on a link to such a page, `reload`, `go-back` and `go-forward`: they wait on the same `load` through
  `act()`. If the cap proves out on `open`/`goto`, a follow-up issue carries it there.

## Definition of Done

- `tests/browser.test.ts`, with a fake view and a manual clock:
  - `navigate` whose `go()` never settles, whose page reports a new `timeOrigin` and `interactive`, evaluates
    `window.stop()` 5 s later and resolves when `go()` then rejects with -999;
  - a `go()` that resolves within the cap: `window.stop()` is never evaluated;
  - a document that stays `loading`: at a time past `LOAD_CAP_MS`, `window.stop()` was not evaluated and the
    `navigate` promise is still pending;
  - a baseline read that gives no number: no read of step 2 and no stop, `navigate` waits for `go()`;
  - a read that never settles: no second read is queued behind it;
  - a stop after which `view.loading` stays true: `navigate` waits for the next landing, as #116.
- `tests/e2e-hangs.test.ts`, "ET-52": on a page whose `<img>` never answers, `open` and then `goto` both
  answer exit 0 within 8 s with the page's title; `eval document.querySelector('h1').textContent` answers;
  a `goto` to another page then works. Today: `BOWSER_E2E=1 bun test tests/e2e-hangs.test.ts -t ET-52` fails
  (the test does not exist yet; the behaviour it checks times out at the budget, measured above).
- Each new test goes red under one mutation of the line it names, quoted in the PR.
- `bun run check` and `BOWSER_E2E=1 bun test` pass; README and `commands.md` describe the cap, and
  `troubleshooting.md` the recovery on a stopped first load.
