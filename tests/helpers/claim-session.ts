// One newcomer in a race for a session's pidfile, as a starting daemon runs
// claimSession. Invoked as
//   bun claim-session.ts <pidFile> /x/src/daemon/main.ts <session>
// so that `ps` shows it as one of our daemons for <session>, which is what a
// later newcomer checks. It waits for <pidFile>.go, claims, prints "won" or
// "lost", and a winner stays alive (holding the claim) until killed.

import { existsSync } from "node:fs";
import { claimSession } from "../../src/daemon/pidfile.ts";

const pidFile = process.argv[2]!;
const session = process.argv.at(-1)!;
// A busy wait, not a timer: the point is that every newcomer starts at once.
while (!existsSync(`${pidFile}.go`)) {}
const won = await claimSession(pidFile, session);
process.stdout.write(won ? "won\n" : "lost\n");
if (won) setInterval(() => {}, 1e9);
else process.exit(0);
