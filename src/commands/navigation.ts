// Navigation and session lifecycle: open, goto, history, close, list.

import { readdir, unlink } from "node:fs/promises";
import { socketPath } from "../daemon/client.ts";
import { ensureSessionDir, loadState, saveState, sessionsRoot, type SessionState } from "../state.ts";
import { connector, emptyState, reply, syncState, withClient, type CommandContext } from "./context.ts";

/** Fail loud when a real navigation still reports about:blank. The daemon's
 *  state op resolves the URL via realUrl() (which falls back to location.href),
 *  so reaching here with about:blank means BOTH the url getter and location.href
 *  agree the page never committed — a genuine load failure, not the chrome
 *  getter quirk (which realUrl already corrects). */
function assertNavigated(requested: string, finalUrl: string): void {
  if (requested && requested !== "about:blank" && finalUrl === "about:blank") {
    throw new Error(`navigate: page did not load ${requested} (ended on about:blank)`);
  }
}

export async function cmdOpen(ctx: CommandContext, url?: string): Promise<string> {
  await ensureSessionDir(ctx.session);
  return withClient(ctx, async (c) => {
    if (url) await c.request("navigate", [url]);
    const state = await c.request("state");
    if (url) assertNavigated(url, state.url);
    const next: SessionState = {
      name: ctx.session, url: state.url, title: state.title, refs: [], updatedAt: Date.now(),
    };
    await saveState(next);
    return reply(ctx, { ok: true, url: state.url, title: state.title }, (url ? `opened ${state.url}  "${state.title}"` : `session '${ctx.session}' ready`));
  });
}

export async function cmdGoto(ctx: CommandContext, url: string): Promise<string> {
  if (!url) throw new Error("usage: bowser goto <url>");
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withClient(ctx, async (c) => {
    await c.request("navigate", [url]);
    const state = await c.request("state");
    assertNavigated(url, state.url);
    await syncState(prev, state);
    return reply(ctx, { ok: true, url: state.url }, `navigated to ${state.url}`);
  });
}

export async function cmdHistory(
  ctx: CommandContext,
  which: "back" | "forward" | "reload",
): Promise<string> {
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withClient(ctx, async (c) => {
    await c.request(which, []);
    const state = await c.request("state");
    await syncState(prev, state);
    return reply(ctx, { ok: true, url: state.url }, (which === "reload" ? `reloaded ${state.url}` : `${which} -> ${state.url}`));
  });
}

export async function cmdClose(
  ctx: CommandContext,
  opts: { name?: string; all?: boolean } = {},
): Promise<string> {
  if (opts.all) return closeAll(ctx);
  return closeOne(ctx, opts.name ?? ctx.session);
}

async function closeOne(ctx: CommandContext, session: string): Promise<string> {
  const prev = await loadState(session);

  // Try to gracefully shut down the daemon. If it's not running, that's fine.
  try {
    const client = await connector(ctx)(session, { spawn: false });
    try {
      await client.request("shutdown");
    } finally {
      client.close();
    }
  } catch {
    // no daemon; that's ok
  }

  // Remove the socket file.
  try {
    await unlink(socketPath(session));
  } catch {}

  await saveState({ ...emptyState(prev?.name ?? session), updatedAt: Date.now() });

  return reply(ctx, { ok: true, session }, `closed session '${session}'`);
}

async function closeAll(ctx: CommandContext): Promise<string> {
  let names: string[] = [];
  try {
    const entries = await readdir(sessionsRoot(), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no sessions root; nothing to close
  }
  const closed: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    try {
      await closeOne(ctx, name);
      closed.push(name);
    } catch {
      failed.push(name); // best-effort: keep closing the rest
    }
  }
  if (ctx.json) return JSON.stringify({ ok: failed.length === 0, closed, failed });
  if (closed.length === 0 && failed.length === 0) return "no sessions to close";
  const parts: string[] = [];
  if (closed.length > 0) {
    const word = closed.length === 1 ? "session" : "sessions";
    parts.push(`closed ${closed.length} ${word}: ${closed.join(", ")}`);
  }
  if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
  return parts.join("; ");
}

export async function cmdList(ctx: CommandContext): Promise<string> {
  try {
    const entries = await readdir(sessionsRoot(), { withFileTypes: true });
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return ctx.json ? JSON.stringify(names) : names.join("\n");
  } catch {
    return ctx.json ? "[]" : "";
  }
}
