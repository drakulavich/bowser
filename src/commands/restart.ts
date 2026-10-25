import pkg from "../../package.json";
import { opTimeoutMs } from "../budget.ts";
import { BrowserExited, HEALTH_PING_MS, OlderDaemon, recordedProfile } from "../daemon/client.ts";
import type { PageState } from "../daemon/protocol.ts";
import { withTimeout } from "../serialize.ts";
import { loadState, saveState } from "../state.ts";
import { connector, type CommandContext } from "./context.ts";
import { cmdOpen, stopDaemon } from "./navigation.ts";
import {
  beingRestarted, claimRestartLock, otherHolder, releaseRestartLock, removeNotice, writeNotice,
} from "./restart-lock.ts";
import { UserError } from "../errors.ts";

/** Whether this command restarted the session. False when it waited for
 *  another command's restart, or found the session closed. */
export async function restartSession(ctx: CommandContext, err: OlderDaemon | BrowserExited): Promise<boolean> {
  const session = ctx.session;
  // No daemon, because another command is restarting it: wait for that one.
  if (err instanceof BrowserExited) {
    if (otherHolder(session) === null) throw err;
    const budget = opTimeoutMs();
    const deadline = budget ? Date.now() + budget : Infinity;
    while (otherHolder(session) !== null) {
      if (Date.now() > deadline) throw beingRestarted(session);
      await Bun.sleep(50);
    }
    return false;
  }
  if (!(await claimRestartLock(session))) return false;
  try {
    // The holder this command waited for may have restarted it already, or a
    // `close` may have ended it: only an older daemon is restarted.
    try {
      (await connector(ctx)(session, { spawn: false })).close();
      return false;
    } catch (err) {
      if (!(err instanceof OlderDaemon)) {
        if (err instanceof UserError) throw err;
        return false;
      }
    }
    const saved = await loadState(session);
    const old = await oldDaemonState(ctx, session);
    const url = old?.url ?? saved?.url ?? "";
    const profile = await recordedProfile(session);
    const page = url && url !== "about:blank" ? url : undefined;
    const lost = profile === null ? "; cookies and storage were lost (no --persistent)" : "";
    const notice = (reload: string) =>
      `session '${session}' restarted for bowser ${pkg.version} (was ${err.was}): ${reload}; refs cleared, run 'bowser snapshot'${lost}`;
    // Left behind if this process is killed before a surface prints it (ET-29).
    writeNotice(session, notice(page ? `page reload at ${page} was interrupted` : "no page was open"));
    try {
      await stopDaemon(ctx, session);
      if (saved) await saveState({ ...saved, refs: [], doc: undefined });
      let reload = page ? `page reloaded at ${page}` : "no page was open";
      try {
        await cmdOpen({ ...ctx, notices: undefined, acks: undefined, json: false, command: "open" }, page, {
          ...(profile === null ? {} : { profile }),
          daemonBudgetMs: old?.budgetMs ?? null,
        });
      } catch (err) {
        if (!page) throw err;
        reload = `page did not reload at ${page} (${err instanceof Error ? err.message : String(err)})`;
      }
      writeNotice(session, notice(reload));
    } catch (err) {
      removeNotice(session);
      throw err;
    }
    return true;
  } finally {
    releaseRestartLock(session);
  }
}

/** The page the old daemon shows and its budget, or undefined when it does not
 *  answer within the health ping: `state` waits behind a busy daemon's op, at
 *  budget 0 for ever (ET-33, ET-30). */
async function oldDaemonState(ctx: CommandContext, session: string): Promise<{ url: string; budgetMs?: number } | undefined> {
  let c;
  try {
    c = await connector(ctx)(session, { spawn: false, anyVersion: true });
  } catch {
    return undefined;
  }
  try {
    const s: Partial<PageState> | undefined = await withTimeout(c.request("state"), HEALTH_PING_MS, "state");
    if (typeof s?.url !== "string") return undefined;
    return typeof s.budgetMs === "number" ? { url: s.url, budgetMs: s.budgetMs } : { url: s.url };
  } catch {
    return undefined;
  } finally {
    c.close();
  }
}
