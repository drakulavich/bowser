// Who holds a session: the pid a daemon records beside its socket, and the
// check that a pid is one of our daemons before anything acts on it. `close`
// uses it to decide whether it may signal; a starting daemon uses it to decide
// whether the session is already claimed.

import { linkSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

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
 *  for 'abc' cannot answer for 'ab'; the daemon runs as
 *  `bun .../daemon/main.ts <session>`, so that marker must be present too.
 *  A daemon a 0.7-or-older release binary started runs as `bowser --daemon
 *  <session>` and may outlive the switch to npm, so `close` still recognises
 *  that form. */
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
  // still recognise a daemon the previous binary started. Old release assets were
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

/** How old the removal lock may get before it counts as abandoned. It is held
 *  for one read and one unlink, so only a process killed inside that window
 *  leaves it behind. */
const LOCK_STALE_MS = 5000;

/** The steps of a claim a test can pause at, to order two newcomers exactly:
 *  `stale-read`, after reading a stale pid and before removing it;
 *  `rechecked`, holding the removal lock, after re-reading that pid and
 *  before unlinking. */
export type ClaimStep = "stale-read" | "rechecked";

/** Claim `session` for this process: make the pidfile with our pid, only if
 *  there is none. Returns false, having touched nothing, when the pidfile
 *  names a live daemon of ours: that daemon holds the session, and a racing
 *  client connects to it as it already polls. A pidfile naming a dead or
 *  foreign pid is stale: it is removed, and the claim is tried once more.
 *
 *  F29: without the claim, concurrent first commands each spawned a daemon,
 *  and each unlinked the other's socket and overwrote its pidfile.
 *
 *  `pause` is for tests only (see ClaimStep). */
export async function claimSession(
  pidFile: string,
  session: string,
  pause: (step: ClaimStep) => Promise<void> = async () => {},
): Promise<boolean> {
  // Bounded: each pass either claims, finds a holder, or sees the pidfile
  // change under it (a holder exited, or another newcomer removed a stale
  // one and is claiming).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryClaim(pidFile)) return true;
    let holder: string;
    try {
      holder = readFileSync(pidFile, "utf8").trim();
    } catch {
      continue; // gone since: claim again
    }
    const pid = Number(holder);
    // A claim is never written empty or partial (tryClaim links a complete
    // file), so such a pidfile is corruption, not a claim in progress. It is
    // left for `close`, which removes the session directory, rather than
    // guessed to be stale.
    if (!/^\d+$/.test(holder) || pid <= 0) return false;
    if (isAlive(pid) && (await isOurDaemon(pid, session))) return false;
    await pause("stale-read");
    // The newcomer that removed the stale pidfile claims now, so a removal
    // never leaves the session with no claimant.
    if (await removeStale(pidFile, holder, pause)) return tryClaim(pidFile);
  }
  return false;
}

/** Make the pidfile hold our pid, only if there is none. The pid is written
 *  to a file of our own first and then hard-linked into place: the link fails
 *  with EEXIST when the pidfile exists, as an O_EXCL create does, and the
 *  pidfile appears with its content. An O_EXCL create followed by a write
 *  left an empty pidfile that another newcomer could take for stale. */
function tryClaim(pidFile: string): boolean {
  const mine = `${pidFile}.${process.pid}.tmp`;
  writeFileSync(mine, String(process.pid));
  try {
    linkSync(mine, pidFile);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    return false;
  } finally {
    try { unlinkSync(mine); } catch {}
  }
}

/** Remove the pidfile only if it still holds `stale`, under a lock, so that
 *  two newcomers that both read the same stale pid cannot have the second
 *  delete the claim the first just made. Only a lock holder removes a
 *  pidfile, and it re-reads the content first: the claim that replaces the
 *  stale one has other content. A newcomer that finds the lock taken leaves
 *  the removal to its holder; its next claim attempt sees the outcome.
 *  Returns whether it removed the pidfile. */
async function removeStale(pidFile: string, stale: string, pause: (step: ClaimStep) => Promise<void>): Promise<boolean> {
  const lock = `${pidFile}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmdirSync(lock);
      mkdirSync(lock);
    } catch {
      return false;
    }
  }
  try {
    if (readFileSync(pidFile, "utf8").trim() !== stale) return false;
    await pause("rechecked");
    unlinkSync(pidFile);
    return true;
  } catch {
    return false; // already gone
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}
