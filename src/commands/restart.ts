import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { opTimeoutMs } from "../budget.ts";
import { BrowserExited, OlderDaemon, recordedProfile } from "../daemon/client.ts";
import { claimSession, isAlive } from "../daemon/pidfile.ts";
import { loadState, saveState, sessionDir } from "../state.ts";
import { connector, type CommandContext } from "./context.ts";
import { cmdOpen, stopDaemon } from "./navigation.ts";
import { UserError } from "../errors.ts";

// As long as `pid`: its claim's temp file, `upg.<pid>.tmp`, must fit the path
// budget maxSessionNameLength() was sized for (`pid.99999.tmp`).
const LOCK = "upg";

export async function restartSession(ctx: CommandContext, err: OlderDaemon | BrowserExited): Promise<void> {
  const session = ctx.session;
  const lock = join(sessionDir(session), LOCK);
  const budget = opTimeoutMs();
  const deadline = budget ? Date.now() + budget : Infinity;
  const timedOut = () => new UserError(`session '${session}' is being restarted by pid ${holder(lock)} (${lock})`);
  // No daemon, because another command is restarting it: wait for that one.
  if (err instanceof BrowserExited) {
    const held = () => { const pid = Number(holder(lock)); return pid > 0 && isAlive(pid); };
    if (!held()) throw err;
    while (held()) {
      if (Date.now() > deadline) throw timedOut();
      await Bun.sleep(50);
    }
    return;
  }
  while (!(await claimSession(lock, session, undefined, async () => true))) {
    if (Date.now() > deadline) throw timedOut();
    await Bun.sleep(50);
  }
  try {
    // The holder this command waited for may have restarted it already.
    try {
      (await connector(ctx)(session, { spawn: false })).close();
      return;
    } catch (err) {
      if (err instanceof UserError && !(err instanceof OlderDaemon)) throw err;
    }
    const saved = await loadState(session);
    const url = saved?.url ?? "";
    if (saved) await saveState({ ...saved, refs: [], doc: undefined });
    const profile = await recordedProfile(session);
    await stopDaemon(ctx, session);
    const page = url && url !== "about:blank" ? url : undefined;
    let reload = page ? `page reloaded at ${page}` : "no page was open";
    try {
      await cmdOpen({ ...ctx, json: false, command: "open" }, page, profile === null ? {} : { profile });
    } catch (err) {
      if (!page) throw err;
      reload = `page did not reload at ${page} (${err instanceof Error ? err.message : String(err)})`;
    }
    const lost = profile === null ? "; cookies and storage were lost (no --persistent)" : "";
    ctx.notices?.push(`session '${session}' restarted for bowser ${pkg.version} (was ${err.was}): ${reload}; refs cleared, run 'bowser snapshot'${lost}`);
  } finally {
    if (holder(lock) === String(process.pid)) {
      try { unlinkSync(lock); } catch {}
    }
  }
}

function holder(lock: string): string {
  try {
    return readFileSync(lock, "utf8").trim();
  } catch {
    return "";
  }
}
