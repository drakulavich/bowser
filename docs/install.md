# Installing and upgrading bowser

bowser runs on macOS only (it needs WebKit, which `Bun.WebView` provides only there).

Bun ≥ 1.4.4 must be on your `PATH`: the npm package runs `src/cli.ts` with the `bun` it finds there.
npm does not enforce that, so on an older Bun a command that would start a session fails with the
error "bowser requires Bun >=1.4.4 (found <version>)" (exit 1).

bowser is distributed only through npm and from source; releases no longer attach binaries. If you
used a release binary, run `bowser close --all` with it, delete it, then
`npm i -g @drakulavich/bowser-cli`.

On another platform, any command that would start a session fails with the error "bowser requires macOS (WebKit)" (exit 1).

## Upgrading

Open sessions survive an upgrade. The first command after it finds the daemon the old bowser
started, stops it, and opens the session again with its profile and its page. It then runs as
asked, and prints one line on stderr first:
"bowser: session '<name>' restarted for bowser <w> (was <v>): page reloaded at <url>; refs cleared,
run 'bowser snapshot'". A session opened without `--persistent` or `--profile` adds "cookies and
storage were lost (no --persistent)": those lived only in the old daemon. When that first command is
`open <url>` or `goto <url>`, the old page is not loaded again and the line says "page at <old url> not
reloaded". A ref from before the
upgrade fails with "is from a page that is no longer loaded", so take a new snapshot. The page is the
one the old daemon showed, and the session keeps the `BOWSER_OP_TIMEOUT_MS` it was opened with. A
session started by bowser 0.12 or older gets the default 30 s instead, whatever the first command after
the upgrade sets. The restart has its own budget, so that first command can take up to twice the budget,
plus a few seconds to stop the old daemon.

From 0.12.0 on, a running `bowser mcp` server hands its calls over to the installed version on the
first tool call after the upgrade, and the restart line comes first in that call's text. A command or
tool call that waited for another one's restart prints the line too. A `bowser mcp` server
that was running when the restart finished gets the line on its next call to that session, once; a CLI
command started after the restart does not (#261). The server's tool list stays the
one the client got when it connected, so a new command shows up once the client restarts the
server. A server started by 0.11 or older can't hand over: restart it once after the upgrade.
It hands over only to a newer version. After a downgrade it keeps running its own version, and the
first tool call's text begins with a line saying the installed bowser is older and that restarting
the MCP server switches to it. If the handover fails, `ping` and `tools/list` are still answered,
and each tool call gets "bowser mcp could not hand over to the installed bowser <v>: <reason>;
restart the MCP server". A call the installed bowser was running when it exited gets "the installed
bowser <v> exited (code N) while running this call" instead.

A daemon newer than the bowser you run (after a downgrade) is still refused: "session '<name>' is
running bowser <v> (this is <w>); run 'bowser close -s <name>', then open it again" (exit 1).
