# bowser works installed under a path with a space, # or % (#150)

## Problem

Installed or checked out under a path that holds a space, `#` or `%`, bowser never starts a daemon.
The exploratory campaign of 2026-10-14 confirmed it by running (ET-57 in
`docs/superpowers/exploratory-testing/2026-10-14-session-log.md`, 9 runs): every first command
waits 5 s and fails with `daemon for session 'a' did not start in time`, exit 2. It happens with
npm prefixes `p_sp ace`, `p_ha#sh` and `p_pc%20t`, with a source copy under `src copy`, through
`bowser mcp`, and on 0.11.0 as well. A control prefix without such characters opened in 394 ms.

`daemonCommand` (`src/daemon/client.ts:340`) builds the daemon's script path with
`new URL("./main.ts", import.meta.url).pathname`. `pathname` keeps the percent-encoding, so the
daemon is spawned with a file that does not exist. `BOWSER_DAEMON_DEBUG=1` shows it:

```
error: Module not found ".../p_sp%20ace/lib/node_modules/@drakulavich/bowser-cli/src/daemon/main.ts"
```

(`%23` for `#`, `%2520` for `%`.) With the daemon started by hand from the right path, `open`,
`list` and `close` all worked, `close` of a SIGSTOPped daemon included, which goes through
`looksLikeOurDaemon`. So the path is the only cause.

The message makes it worse. It names no cause and no next step, and with `--persistent` it names
the wrong one: `did not start in time with --persistent profile <dir>; the browser may not support
a persistent profile here` (`src/daemon/client.ts:326`). The same guess showed up in ET-32, where
the cause was a race with `close`, not the browser.

Other places that turn a module URL into something on disk, checked with
`grep -rn "import.meta" src`:

- `src/mcp.ts:433` already uses `Bun.fileURLToPath` (fixed in #149).
- `src/mcp.ts:454` and `src/daemon/client.ts:202` pass the `URL` object to `Bun.file`, which
  decodes it. Checked with a `package.json` under `p sp#a%20c`: `Bun.file(new URL(...)).json()`
  read it, while `.pathname` gave `p%20sp%23a%2520c`.
- `tests/commands.test.ts:805` uses `.pathname` to build an expected command line.

## Change

1. `daemonCommand` returns `Bun.fileURLToPath(new URL("./main.ts", import.meta.url))` in place of
   `.pathname`. `looksLikeOurDaemon` still recognises the result: it takes the session from the
   last word and the marker from the word before it, and that word still ends in
   `/src/daemon/main.ts` when an earlier directory has a space. Checked:
   `looksLikeOurDaemon("<bun> /a b/src/daemon/main.ts sess", "sess")` is `true`.
2. `tests/commands.test.ts:805` uses `Bun.fileURLToPath` too, so no module URL is read through
   `.pathname` anywhere.
3. "did not start in time" stops guessing. The `--persistent` hint goes: when the browser refuses
   a profile, the daemon dies with `--persistent: the browser refused profile <dir>: <cause>`
   (`src/browser.ts:154`), but only its log shows that, and the CLI cannot tell that case from any
   other. Kept, the guess points at the browser for a path bug (ET-57) and for a race (ET-32).
4. Without `BOWSER_DAEMON_DEBUG=1`, the message ends `; rerun with BOWSER_DAEMON_DEBUG=1 to see
   why`. With it, the message keeps today's `; its output is in <log path>`. A rerun is safe: a
   daemon that never started leaves no `state.json`, so the next `open` spawns again. Point 3 needs
   this one: with the guess gone, the log is where a refused profile shows up.

Decisions on the two extras #150 asked for:

- (a) Dropping the persistent-profile guess is in. It is one deleted clause, and today it names a
  wrong cause in two confirmed findings.
- (b) Naming `BOWSER_DAEMON_DEBUG=1` is in. It is one changed string, and it is the only way a user
  reaches the cause, here or for any other daemon that dies before its socket opens.

CHANGELOG `[Unreleased]`, under Fixed: one entry for the install path and the message.

## Tests

How tests spawn daemons today: `tests/e2e-upgrade.test.ts` copies `src/` and `package.json` into a
temp directory and runs the copy's `src/cli.ts` with a temp `HOME`; `tests/e2e-spawn-exit.test.ts`
runs the CLI as its own process and breaks a daemon's start by putting a directory where its socket
goes. The new tests reuse both.

- `tests/daemon.test.ts`, in `describe("daemonCommand")`: "names a main.ts that exists under a
  path with a space, # or %". It copies `src/` and `package.json` (which `client.ts` imports) into
  a temp directory named `in st#all%20`, imports
  that copy's `src/daemon/client.ts` by its file URL, and checks that `daemonCommand("sess")[1]`
  exists on disk and that `looksLikeOurDaemon` accepts the joined command line for `sess` only. No
  browser, so it runs in plain `bun test` and in the unit CI job. It fails today: the path holds
  `in%20st%23all%2520`.
- `tests/e2e-install-path.test.ts` (new, `BOWSER_E2E=1`): the package copied to `in st#all%20` as
  in `e2e-upgrade`, `HOME` a temp directory. The copy's `open data:text/html,<title>ip</title>`
  exits 0 and prints `ip`; `daemonPids` from `tests/helpers/daemons.ts` finds one daemon whose
  command line holds the copy's path; the copy's `list` names the session; `close` exits 0 and no
  daemon is left. This is what #150's "What" asks for. `bowser mcp` spawns through the same
  `daemonCommand`, so it gets no test of its own.
- `tests/e2e-spawn-exit.test.ts`, next to the F6 test of a daemon that fails to start: "says to
  rerun with BOWSER_DAEMON_DEBUG=1 when the daemon fails to start". The same broken socket, run
  without `BOWSER_DAEMON_DEBUG` and with `--persistent`: exit 2, stderr has `did not start in time;
  rerun with BOWSER_DAEMON_DEBUG=1 to see why` and no `may not support a persistent profile`. The
  existing F6 test keeps checking the debug-on wording.

## Out of scope

- A `bun` executable whose own path has a space, such as `~/.bun/bin/bun` under
  `/Users/John Smith`. `looksLikeOurDaemon` matches the executable by its first word, so it
  rejects such a daemon: `looksLikeOurDaemon("/Users/John Smith/.bun/bin/bun /x/src/daemon/main.ts
  sess", "sess")` is `false`. Spawning works; `close` of a daemon that does not answer and the
  session-claim race would not recognise it. ET-57 ran with bun at a plain path, so nothing has
  shown it yet. Tracked in #156.
- Telling a refused persistent profile apart in the CLI (checking the macOS version, or reading
  the daemon's last words without `BOWSER_DAEMON_DEBUG`). Point 4 sends the user to the log
  instead. If that proves not enough, it goes back to #150.
- The rest of the "did not start in time" cases the campaign met (ET-63, a removed socket; `ro7`,
  a read-only session directory): they get the new pointer to the log and nothing more. Their
  causes are tracked in #155.

## Definition of Done

- `bun test tests/daemon.test.ts -t "path with a space"` passes (today: matches 0 tests, exit 1).
  It fails if `daemonCommand` goes back to `.pathname`.
- `BOWSER_E2E=1 bun test ./tests/e2e-install-path.test.ts` passes (today: no such file, exit 1).
- `BOWSER_E2E=1 bun test tests/e2e-spawn-exit.test.ts -t "says to rerun with BOWSER_DAEMON_DEBUG=1"`
  passes (today: matches 0 tests, exit 1), and so does the whole file.
- `grep -rn "import.meta.url).pathname\|may not support a persistent profile" src tests` prints
  nothing (today: `src/daemon/client.ts:326`, `src/daemon/client.ts:340`,
  `tests/commands.test.ts:805`).
- `bun run check` passes. It passes today too (1046 pass, 318 skip, 0 fail), so it only guards
  against regressions.
