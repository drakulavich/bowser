// Who holds a session: the pid a daemon records beside its socket, and the
// check that a pid is one of our daemons before anything acts on it. `close`
// uses it to decide whether it may signal; a starting daemon uses it to decide
// whether the session is already claimed.

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
