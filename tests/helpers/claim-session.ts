// One newcomer in a race for a session's pidfile, running claimSession as a
// starting daemon does, with no browser. Invoked as
//   bun claim-session.ts <pidFile> <pauseAt> /x/src/daemon/main.ts <session>
// so that `ps` shows it as one of our daemons for <session>, which is what
// another newcomer checks. <pauseAt> is a claimSession step ("stale-read",
// "rechecked") or "-": at that step it creates <pidFile>.paused-<pid> and
// waits for <pidFile>.release-<pid>, so a test can order two newcomers'
// steps exactly. It prints "won" or "lost"; a winner stays alive, holding
// the claim, until killed.

import { existsSync, writeFileSync } from "node:fs";
import { claimSession } from "../../src/daemon/pidfile.ts";

const [pidFile, pauseAt] = [process.argv[2]!, process.argv[3]!];
const session = process.argv.at(-1)!;
let paused = false;
const won = await claimSession(pidFile, session, async (step) => {
  if (step !== pauseAt || paused) return;
  paused = true;
  writeFileSync(`${pidFile}.paused-${process.pid}`, "");
  while (!existsSync(`${pidFile}.release-${process.pid}`)) await Bun.sleep(5);
});
process.stdout.write(won ? "won\n" : "lost\n");
if (won) setInterval(() => {}, 1e9);
else process.exit(0);
