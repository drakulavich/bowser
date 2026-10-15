// The lock an upgrade restart and `close` hold on a session (`upg`), and the
// notice a restart leaves for the next surface to print (`msg`) (#149, #152).

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opTimeoutMs } from "../budget.ts";
import { claimSession, isAlive } from "../daemon/pidfile.ts";
import { sessionDir } from "../state.ts";
import { UserError } from "../errors.ts";

// As long as `pid`: their temp files, `upg.<pid>.tmp` and `msg.<pid>.tmp`,
// must fit the path budget maxSessionNameLength() was sized for (`pid.99999.tmp`).
export const LOCK = "upg";
const MSG = "msg";

export const lockPath = (session: string) => join(sessionDir(session), LOCK);
const msgPath = (session: string) => join(sessionDir(session), MSG);

export function beingRestarted(session: string): UserError {
  const lock = lockPath(session);
  return new UserError(`session '${session}' is being restarted by pid ${readTrimmed(lock)} (${lock})`);
}

/** Claims the session's lock, waiting while a live pid holds it, up to the op
 *  budget (no deadline at 0). False when the session directory is gone. */
export async function claimRestartLock(session: string, claim = claimSession): Promise<boolean> {
  const lock = lockPath(session);
  const budget = opTimeoutMs();
  const deadline = budget ? Date.now() + budget : Infinity;
  for (;;) {
    try {
      if (await claim(lock, session, undefined, async () => true)) return true;
    } catch (e) {
      // ENAMETOOLONG: a name no daemon could have claimed under this HOME (F35).
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENAMETOOLONG") return false;
      throw e;
    }
    if (Date.now() > deadline) throw beingRestarted(session);
    await Bun.sleep(50);
  }
}

export function releaseRestartLock(session: string): void {
  const lock = lockPath(session);
  if (readTrimmed(lock) === String(process.pid)) {
    try { unlinkSync(lock); } catch {}
  }
}

/** The live pid of another process that holds the lock, or null. */
export function otherHolder(session: string): number | null {
  const pid = Number(readTrimmed(lockPath(session)));
  return pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
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
  try { unlinkSync(msgPath(session)); } catch {}
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
