// Navigation and session lifecycle: open, goto, history, close, list.

import { readdir, unlink } from "node:fs/promises";
import type { Command } from "../cli/registry.ts";
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
    const text = url ? `opened ${state.url}  "${state.title}"` : `session '${ctx.session}' ready`;
    return reply(ctx, { ok: true, url: state.url, title: state.title }, text);
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
    const text = which === "reload" ? `reloaded ${state.url}` : `${which} -> ${state.url}`;
    return reply(ctx, { ok: true, url: state.url }, text);
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

/** A session is live when its daemon answers. The socket file alone is not
 *  enough — a stale socket outlives a crashed daemon — and a pid alone is not
 *  either, since an orphan holds no socket. `ping` is on the urgent lane, so a
 *  busy daemon still answers and reads as live, which is correct. */
async function isLive(ctx: CommandContext, session: string): Promise<boolean> {
  try {
    const c = await connector(ctx)(session, { spawn: false });
    try {
      await c.request("ping");
      return true;
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

export async function cmdList(ctx: CommandContext): Promise<string> {
  let names: string[] = [];
  try {
    const entries = await readdir(sessionsRoot(), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no sessions root; nothing is live
  }
  // A directory is not a session an agent can use, so every name is probed.
  // Concurrently: one dead session waits out a connect, and serially that cost
  // would multiply by however many directories have accumulated.
  const live = await Promise.all(names.map((n) => isLive(ctx, n)));
  const usable = names.filter((_, i) => live[i]);
  return ctx.json ? JSON.stringify(usable) : usable.join("\n");
}

export const COMMANDS: Command[] = [
  {
    name: "open",
    summary: "Start or attach to a session; navigate if a URL is given",
    positional: [{ name: "url", required: false }],
    flags: [],
    run: (ctx, a) => cmdOpen(ctx, a.positional[0]),
  },
  {
    name: "goto",
    summary: "Navigate the current session to a URL",
    positional: [{ name: "url", required: true }],
    flags: [],
    run: (ctx, a) => cmdGoto(ctx, a.positional[0] ?? ""),
  },
  {
    name: "close",
    summary: "Close a session (or all sessions with --all)",
    positional: [{ name: "session", required: false }],
    flags: [{ name: "all", kind: "boolean" }],
    run: (ctx, a) => cmdClose(ctx, { name: a.positional[0], all: Boolean(a.flags.all) }),
  },
  {
    name: "go-back",
    summary: "Navigate back in history",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "back"),
  },
  {
    name: "go-forward",
    summary: "Navigate forward in history",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "forward"),
  },
  {
    name: "reload",
    summary: "Reload the current page",
    positional: [], flags: [],
    run: (ctx) => cmdHistory(ctx, "reload"),
  },
  {
    name: "list",
    summary: "List sessions",
    positional: [], flags: [],
    run: (ctx) => cmdList(ctx),
  },
];
