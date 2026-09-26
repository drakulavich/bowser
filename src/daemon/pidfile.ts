// Who holds a session: the pid a daemon records beside its socket, and the
// check that a pid is one of our daemons before anything acts on it. `close`
// uses it to decide whether it may signal; a starting daemon uses it to decide
// whether the session is already claimed.

import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/** True when `pid` names a running process, ours or anyone's. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and is someone else's — alive, and the
    // ownership check is what decides whether we may touch it.
    return (e as { code?: string }).code === "EPERM";
  }
}

/** True when `pid` is one of our daemons for `session`. Nothing here signals a
 *  pid without asking this first: pids are reused, and killing a stranger's
 *  process because a stale file named it would be far worse than leaking one of
 *  ours. The session must be a whole argument, not a substring, so the daemon
 *  for 'abc' cannot answer for 'ab'; the daemon runs either as
 *  `bun .../daemon/main.ts <session>` or, compiled, as `bowser --daemon
 *  <session>`, so one of those two markers must be present too. */
export function looksLikeOurDaemon(command: string, session: string): boolean {
  const line = command.trim();
  // The session is the daemon's last argument and the marker comes right
  // before it. `sessionDir` keeps whitespace out of session names, so the
  // display line `ps` prints splits cleanly into words.
  const words = line.split(/\s+/);
  if (words.at(-1) !== session) return false;
  const marker = words.at(-2) ?? "";
  // Match the executable by name, not by path: the path changes across
  // upgrades (a Homebrew Cellar path carries the version), and `close` must
  // still recognise a daemon the previous binary started. Release assets are
  // named `bowser-macos-arm64` and the like, so a `bowser-` or `bowser.`
  // prefix counts too; `not-bowser-helper` does not.
  const exe = words[0]?.split("/").pop() ?? "";
  if (/^bowser([-.]|$)/.test(exe)) return marker === "--daemon";
  return exe === "bun" && marker.endsWith("/src/daemon/main.ts");
}

export async function isOurDaemon(pid: number, session: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // A pid that no longer exists prints nothing, which no session name matches.
    return looksLikeOurDaemon(await new Response(proc.stdout).text(), session);
  } catch {
    return false;
  }
}

/** How long a pidfile may stay empty before it counts as stale: a claimant
 *  creates it and writes its pid in two steps, and a reader can land between. */
const EMPTY_GRACE_MS = 1000;

/** How old the removal lock may get before it counts as abandoned. It is held
 *  for one read and one unlink, so only a process killed inside that window
 *  leaves it behind. */
const LOCK_STALE_MS = 5000;

/** Claim `session` for this process: create its pidfile exclusively (O_EXCL)
 *  with our pid. Returns false, having touched nothing, when the pidfile names
 *  a live daemon of ours: that daemon holds the session, and a racing client
 *  connects to it as it already polls. A pidfile naming a dead or foreign pid
 *  is stale: it is removed, and the claim is tried once more.
 *
 *  F29: without the claim, concurrent first commands each spawned a daemon,
 *  and each unlinked the other's socket and overwrote its pidfile. */
export async function claimSession(pidFile: string, session: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pidFile, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    const holder = await readHolder(pidFile);
    if (holder === null) continue; // its daemon exited just now: claim again
    const pid = Number(holder);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid) && (await isOurDaemon(pid, session))) return false;
    removeStale(pidFile, holder);
  }
  return false;
}

/** The pidfile's content, or null when it is gone. An empty file is a claim
 *  still being written, so it is read again until the grace runs out. */
async function readHolder(pidFile: string): Promise<string | null> {
  const deadline = Date.now() + EMPTY_GRACE_MS;
  for (;;) {
    let text: string;
    try {
      text = readFileSync(pidFile, "utf8").trim();
    } catch {
      return null;
    }
    if (text || Date.now() >= deadline) return text;
    await Bun.sleep(20);
  }
}

/** Remove the pidfile only if it still holds `stale`, under a lock, so that
 *  two newcomers that both read the same stale pid cannot have the second
 *  delete the claim the first just made. Only a lock holder removes a
 *  pidfile, and it re-reads the content first: the claim that replaces the
 *  stale one has other content. A newcomer that finds the lock taken leaves
 *  the removal to its holder; its next claim attempt sees the outcome. */
function removeStale(pidFile: string, stale: string): void {
  const lock = `${pidFile}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return;
      rmdirSync(lock);
      mkdirSync(lock);
    } catch {
      return;
    }
  }
  try {
    if (readFileSync(pidFile, "utf8").trim() === stale) unlinkSync(pidFile);
  } catch {
    // Already gone.
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}
