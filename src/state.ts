// State persisted between CLI invocations.
// One-shot mode means each command spawns a fresh WebView, so we need to
// persist just enough to make multi-step flows work:
//   - the current URL (so we can re-navigate)
//   - the last snapshot's refs (a ref command checks the ref's kind against it)
//
// State lives under ~/.bowser/sessions/<name>/.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.ts";

export interface Ref {
  id: string; // "e1", no '@' prefix (playwright-cli compatible)
  role: string;
  name: string;
  tag: string;
  href?: string;
  value?: string;
  /** The element is contentEditable; `fill` accepts it whatever its role. */
  editable?: boolean;
}

export interface SessionState {
  name: string;
  url: string;
  title: string;
  refs: Ref[];
  updatedAt: number;
}

/** Root of per-session state, resolved at call time from process.env.HOME so
 *  tests that redirect HOME stay isolated. A module-level const would capture
 *  the real home at import (before beforeAll runs). */
export function sessionsRoot(): string {
  return join(process.env.HOME || homedir(), ".bowser", "sessions");
}

/** Root of `open --persistent` profiles. Beside the sessions root, never
 *  inside a session directory: `close` deletes that one, and the profile must
 *  outlive it. Call-time for the same reason as sessionsRoot(). */
function profilesRoot(): string {
  return join(process.env.HOME || homedir(), ".bowser", "profiles");
}

/** The browser profile `open --persistent` gives a session. */
export function profileDir(name: string): string {
  sessionDir(name); // validates the name: it becomes a path here too
  return join(profilesRoot(), name);
}

export function isValidSessionName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name);
}

/** APFS's NAME_MAX. The name is ASCII, so characters are bytes. */
const NAME_MAX = 255;
/** The longest path Bun opens or binds. Measured on macOS, Bun 1.4.2: both
 *  `writeFileSync` and listening on a Unix socket fail at 1017 characters. Bun
 *  binds a socket through its directory, so the 104-byte `sun_path` limits
 *  only the socket's own name (`sock`), not the whole path. */
const BUN_PATH_MAX = 1016;
/** The longest entry a session directory gets: the daemon's pidfile claim,
 *  `pid.<pid>.tmp`, with a pid of at most 5 digits (macOS's PID_MAX 99999). */
const LONGEST_ENTRY = "pid.99999.tmp";

/** The longest session name a session can be created under, for this HOME.
 *  Past it, mkdir failed with ENAMETOOLONG, or the daemon died claiming its
 *  pidfile and `open` said only "did not start in time" (F35). */
export function maxSessionNameLength(): number {
  const byPath = BUN_PATH_MAX - sessionsRoot().length - "/".length - `/${LONGEST_ENTRY}`.length;
  return Math.min(NAME_MAX, byPath);
}

/** Refuses a name too long to create a session under. Only where a session
 *  is created: `close` must still remove a directory an older bowser left
 *  with such a name, so `sessionDir` does not check it. */
export function checkNewSessionName(name: string): void {
  const max = maxSessionNameLength();
  if (name.length > max) {
    throw new UserError(
      `usage: session name is too long for this HOME: at most ${max} characters under ${sessionsRoot()}, got ${name.length}`,
    );
  }
}

/** Every filesystem path for a session goes through here, so this is where a
 *  name is checked. A session name arrives from `-s` unfiltered, and `close`
 *  removes the directory it names recursively, so `../../Documents` must never
 *  get this far. The name also ends up on the daemon's command line, where
 *  `looksLikeOurDaemon` reads it back from `ps`: no spaces and no leading dash,
 *  or `--daemon victim` would pass for the daemon of `victim`. */
export function sessionDir(name: string): string {
  if (!isValidSessionName(name)) {
    throw new UserError(
      `usage: session name may use only letters, digits, '.', '_' and '-', and must not start with '.' or '-', got ${JSON.stringify(name)}`,
    );
  }
  return join(sessionsRoot(), name);
}

export async function ensureSessionDir(name: string): Promise<string> {
  const dir = sessionDir(name);
  checkNewSessionName(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The session's saved page and refs. Its presence also says a daemon ran
 *  for the session (connectOrSpawn reads it that way). */
export function statePath(name: string): string {
  return join(sessionDir(name), "state.json");
}

export async function loadState(name: string): Promise<SessionState | null> {
  const path = statePath(name);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as SessionState;
  } catch {
    return null;
  }
}

export async function saveState(state: SessionState): Promise<void> {
  await ensureSessionDir(state.name);
  await Bun.write(statePath(state.name), JSON.stringify(state, null, 2));
}

export function resolveRef(state: SessionState, ref: string): Ref {
  if (!/^e\d+$/.test(ref)) {
    throw new UserError(
      `expected a ref like 'e1', got '${ref}'. Run 'bowser snapshot' first.`,
    );
  }
  const found = state.refs.find((r) => r.id === ref);
  if (!found) {
    throw new UserError(
      `ref '${ref}' not found in last snapshot of session '${state.name}'. ` +
        `Run 'bowser snapshot' to refresh.`,
    );
  }
  return found;
}
