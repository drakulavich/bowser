// The lock an upgrade restart and `close` hold on a session (`upg`), and the
// notice a restart leaves for the next surface to print (`msg`) (#149, #152).

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opTimeoutMs } from "../budget.ts";
import { claimSession, isAlive, isBowser } from "../daemon/pidfile.ts";
import { sessionDir } from "../state.ts";
import { UserError } from "../errors.ts";

// As long as `pid`: their temp files, `upg.<pid>.tmp` and `msg.<pid>.tmp`,
// must fit the path budget maxSessionNameLength() was sized for (`pid.99999.tmp`).
export const LOCK = "upg";
export const MSG = "msg";

const lockPath = (session: string) => join(sessionDir(session), LOCK);
const msgPath = (session: string) => join(sessionDir(session), MSG);

export function beingRestarted(session: string): UserError {
  const lock = lockPath(session);
  return new UserError(`session '${session}' is being restarted by pid ${readTrimmed(lock)} (${lock}); retry in a moment`);
}

/** Claims the session's lock, waiting while a live bowser process holds it, up to the op
 *  budget (no deadline at 0). False when the session directory is gone or the
 *  lock is corrupt. */
export async function claimRestartLock(session: string, claim = claimSession): Promise<boolean> {
  const lock = lockPath(session);
  const budget = opTimeoutMs();
  const deadline = budget ? Date.now() + budget : Infinity;
  for (;;) {
    try {
      if (await claim(lock, session, undefined, async (pid) => isBowser(pid))) return true;
    } catch (e) {
      // ENAMETOOLONG: a name no daemon could have claimed under this HOME (F35).
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENAMETOOLONG") return false;
      throw e;
    }
    // claimSession leaves a corrupt lock for `close`, which removes the directory.
    if (corrupt(lock)) return false;
    if (Date.now() > deadline) throw beingRestarted(session);
    await Bun.sleep(50);
  }
}

export function releaseRestartLock(session: string): void {
  const lock = lockPath(session);
  if (readTrimmed(lock) === String(process.pid)) {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

/** The pid of another live bowser process that holds the lock, or null. */
export function otherHolder(session: string): number | null {
  const pid = Number(readTrimmed(lockPath(session)));
  return pid > 0 && pid !== process.pid && isAlive(pid) && isBowser(pid) ? pid : null;
}

export function writeNotice(session: string, text: string): void {
  const path = msgPath(session);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readNotice(session: string): string {
  return readTrimmed(msgPath(session));
}

export function removeNotice(session: string): void {
  try {
    unlinkSync(msgPath(session));
  } catch {}
}

function corrupt(lock: string): boolean {
  let held: string;
  try {
    held = readFileSync(lock, "utf8").trim();
  } catch {
    return false;
  }
  return !/^\d+$/.test(held) || Number(held) <= 0;
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
