// The daemons running for a session, read from `ps`, so a daemon nobody can
// reach (no socket, no pidfile) is counted too. Tests use it to count and to
// clean up only the daemons of their own sessions.

import { looksLikeOurDaemon } from "../../src/daemon/pidfile.ts";

export async function daemonPids(session: string): Promise<number[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && looksLikeOurDaemon(m[2]!, session)) pids.push(Number(m[1]));
  }
  return pids;
}

/** SIGKILL every daemon of `session`: cleanup after a test that may have
 *  left several (the bug it tests). */
export async function killDaemons(session: string): Promise<void> {
  for (const pid of await daemonPids(session)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/** Poll `check` until it holds or `ms` runs out; returns its last answer. */
export async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}
