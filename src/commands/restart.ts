import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { opTimeoutMs } from "../budget.ts";
import { OlderDaemon, recordedProfile } from "../daemon/client.ts";
import { claimSession } from "../daemon/pidfile.ts";
import { loadState, sessionDir } from "../state.ts";
import { connector, type CommandContext } from "./context.ts";
import { cmdOpen, stopDaemon } from "./navigation.ts";
import { UserError } from "../errors.ts";

// As long as `pid`: its claim's temp file, `upg.<pid>.tmp`, must fit the path
// budget maxSessionNameLength() was sized for (`pid.99999.tmp`).
const LOCK = "upg";

export async function restartSession(ctx: CommandContext, older: OlderDaemon): Promise<void> {
  const session = ctx.session;
  const lock = join(sessionDir(session), LOCK);
  const deadline = Date.now() + opTimeoutMs();
  while (!(await claimSession(lock, session, undefined, async () => true))) {
    if (Date.now() > deadline) throw new UserError(`session '${session}' is being restarted by pid ${holder(lock)} (${lock})`);
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
    const url = (await loadState(session))?.url ?? "";
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
    ctx.notices?.push(`session '${session}' restarted for bowser ${pkg.version} (was ${older.was}): ${reload}; refs cleared, run 'bowser snapshot'${lost}`);
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
