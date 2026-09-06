// Navigation and session lifecycle: open, goto, history, close, list.

import { readFile, readdir, rm, unlink } from "node:fs/promises";
import type { Command } from "../cli/registry.ts";
import { pidPath, socketPath } from "../daemon/client.ts";
import {
  ensureSessionDir, loadState, saveState, sessionDir, sessionsRoot, type SessionState,
} from "../state.ts";
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

/** The three process facts `close` needs, injectable so the paths that decide
 *  whether to signal can be tested without a real daemon to kill. */
export interface ProcessOps {
  alive: (pid: number) => boolean;
  ours: (pid: number, session: string) => Promise<boolean>;
  term: (pid: number) => void;
  /** How long a daemon gets to disappear, per attempt. */
  graceMs: number;
}

/** True when `pid` is one of our daemons for `session`. Nothing here signals a
 *  pid without asking this first: pids are reused, and killing a stranger's
 *  process because a stale file named it would be far worse than leaking one of
 *  ours. The session must be a whole argument, not a substring, so the daemon
 *  for 'abc' cannot answer for 'ab'; the daemon runs either as
 *  `bun .../daemon/main.ts <session>` or, compiled, as `bowser --daemon
 *  <session>`, so one of those two markers must be present too. */
export function looksLikeOurDaemon(command: string, session: string): boolean {
  const argv = command.trim().split(/\s+/);
  const isDaemon = argv.some((a) => a === "--daemon" || a.endsWith("daemon/main.ts"));
  return isDaemon && argv.includes(session);
}

async function isOurDaemon(pid: number, session: string): Promise<boolean> {
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

const realProcess: ProcessOps = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the process exists and is someone else's — alive, and the
      // ownership check is what decides whether we may touch it.
      return (e as { code?: string }).code === "EPERM";
    }
  },
  ours: isOurDaemon,
  term(pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  },
  graceMs: 2000,
};

/** The pid the daemon recorded for this session, or null if it recorded none
 *  (a session from before pidfiles, or one whose daemon never started). */
async function readPid(session: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(pidPath(session), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Poll until `pid` is gone, up to the grace period, and report whether it went. */
async function waitGone(proc: ProcessOps, pid: number): Promise<boolean> {
  const deadline = Date.now() + proc.graceMs;
  while (Date.now() < deadline) {
    if (!proc.alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !proc.alive(pid);
}

/** Exported for tests, which supply their own `proc` to exercise the paths that
 *  decide whether to signal a pid. `cmdClose` is the command entry point. */
export async function closeOne(
  ctx: CommandContext,
  session: string,
  proc: ProcessOps = realProcess,
): Promise<string> {
  const pid = await readPid(session);

  // Ask the daemon to stop. Failing to connect is not yet an error: the daemon
  // may be gone already, or unreachable while still running — which is the case
  // the pid below exists to settle, and which used to be reported as success.
  try {
    const client = await connector(ctx)(session, { spawn: false });
    try {
      await client.request("shutdown");
    } finally {
      client.close();
    }
  } catch {}

  // Remove the socket file.
  try {
    await unlink(socketPath(session));
  } catch {}

  let ended = false;
  if (pid !== null && !(await waitGone(proc, pid))) {
    // Still running after being asked to stop, or never reachable to ask. A pid
    // that is not ours is a reused number and the daemon is already gone.
    if (await proc.ours(pid, session)) {
      proc.term(pid);
      ended = true;
      if (!(await waitGone(proc, pid))) {
        throw new Error(
          `close: daemon for session '${session}' (pid ${pid}) is still running`,
        );
      }
    }
  }

  // The directory outlives nothing now: keeping it is what let closed sessions
  // accumulate, and after close there is no state left in it worth reading.
  await rm(sessionDir(session), { recursive: true, force: true });

  const text = ended
    ? `closed session '${session}' (ended unreachable daemon ${pid})`
    : `closed session '${session}'`;
  return reply(ctx, { ok: true, session, ended }, text);
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
      // Cap the probe. A daemon can hold a connectable socket and never answer
      // — stopped, or blocked in a syscall — and `list` must report it rather
      // than hang on it. A live daemon answers in microseconds; the urgent lane
      // means a busy one does too.
      return await Promise.race([
        c.request("ping").then(() => true),
        Bun.sleep(LIVE_PROBE_MS).then(() => false),
      ]);
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

const LIVE_PROBE_MS = 1000;

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
    summary: "Close a session and remove its data (or all with --all)",
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
    summary: "List sessions whose daemon is running",
    positional: [], flags: [],
    run: (ctx) => cmdList(ctx),
  },
];
