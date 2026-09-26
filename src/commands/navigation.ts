// Navigation and session lifecycle: open, goto, history, close, list.

import { readFile, readdir, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { str } from "../cli/parser.ts";
import type { Command } from "../cli/registry.ts";
import { pidPath, socketPath } from "../daemon/client.ts";
import { isAlive, isOurDaemon } from "../daemon/pidfile.ts";
import {
  ensureSessionDir, isValidSessionName, loadState, profileDir, saveState, sessionDir, sessionsRoot, type SessionState,
} from "../state.ts";
import { connector, emptyState, reply, replyPage, syncState, withPageClient, type CommandContext } from "./context.ts";

/** Fail loud when a real navigation still reports about:blank. The daemon's
 *  state op resolves the URL via realUrl() (view.url, or location.href when that
 *  is empty), so reaching here with about:blank means the page never
 *  committed — a genuine load failure. */
function assertNavigated(requested: string, finalUrl: string): void {
  if (requested && requested !== "about:blank" && finalUrl === "about:blank") {
    throw new Error(`navigate: page did not load ${requested} (ended on about:blank)`);
  }
}

/** Hosts that serve plain HTTP by default: a scheme-less URL for one of
 *  them gets `http://`, every other host `https://`. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Add a scheme to a URL typed without one, as playwright-cli does:
 *  `example.com` → `https://example.com`, `localhost:3000/x` →
 *  `http://localhost:3000/x`. A URL has no scheme when `new URL()` rejects it,
 *  or when it starts with `host:port`, which `new URL()` would read as a
 *  scheme (WebKit then times out on `localhost:3000`). Any URL with a real
 *  scheme passes through unchanged. Unlike playwright-cli, `127.0.0.1` gets
 *  `http://`: its `https://` only fails. */
export function normalizeUrl(url: string): string {
  if (!url || (URL.canParse(url) && !startsWithHostPort(url))) return url;
  let host = "";
  try {
    host = new URL(`http://${url}`).hostname;
  } catch {
    // Not a URL even with a scheme: https:// it is, and the navigation says why.
  }
  return `${LOCAL_HOSTS.has(host) ? "http" : "https"}://${url}`;
}

/** `localhost:3000`, `example.com:8080/x`, `[::1]:3000`: a host and a numeric
 *  port, then the end, a path, a query or a fragment. The host must be
 *  `localhost`, bracketed IPv6, or contain a dot, so a real scheme with a
 *  number after it (`tel:5551234`) is left alone. */
function startsWithHostPort(url: string): boolean {
  const m = /^(\[[^\]]*\]|[^/:?#]+):\d+(?:[/?#]|$)/.exec(url);
  if (!m) return false;
  const host = m[1]!.toLowerCase();
  return host === "localhost" || host.startsWith("[") || host.includes(".");
}

export interface OpenOptions {
  persistent?: boolean;
  /** Profile directory, relative to the cwd; implies `persistent` and wins over it. */
  profile?: string;
}

export async function cmdOpen(ctx: CommandContext, typed?: string, opts: OpenOptions = {}): Promise<string> {
  const url = typed === undefined ? undefined : normalizeUrl(typed);
  // The parser accepts `--profile=`; treating it as absent would quietly
  // start an ephemeral session the caller believes is persistent.
  if (opts.profile !== undefined && !opts.profile.trim()) {
    throw new Error("usage: --profile needs a directory, e.g. --profile=./profile");
  }
  await ensureSessionDir(ctx.session);
  const profile = opts.profile !== undefined
    ? resolve(opts.profile)
    : opts.persistent ? profileDir(ctx.session) : undefined;
  // The directory is created only when a new daemon is spawned for it
  // (spawnDaemon), so a refused open (below) leaves nothing behind.
  return withPageClient(ctx, async (c) => {
    // The store is fixed when the daemon starts. A daemon that was already
    // running may have another one, and navigating it would silently lose
    // the persistence asked for, so refuse before touching the page.
    if (profile && (await c.request("state")).profile !== profile) {
      throw new Error(
        `usage: session '${ctx.session}' is already open with a different profile; run 'bowser close' first`,
      );
    }
    if (url) await c.request("navigate", [url]);
    const state = await c.request("state");
    if (url) assertNavigated(url, state.url);
    const next: SessionState = {
      name: ctx.session, url: state.url, title: state.title, refs: [], updatedAt: Date.now(),
    };
    await saveState(next);
    const text = url ? `opened ${state.url}  "${state.title}"` : `session '${ctx.session}' ready`;
    return replyPage(ctx, c, { ok: true, url: state.url, title: state.title }, text);
  }, { profile });
}

export async function cmdGoto(ctx: CommandContext, typed: string): Promise<string> {
  if (!typed) throw new Error("usage: bowser goto <url>");
  const url = normalizeUrl(typed);
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withPageClient(ctx, async (c) => {
    await c.request("navigate", [url]);
    const state = await c.request("state");
    assertNavigated(url, state.url);
    await syncState(prev, state);
    return replyPage(ctx, c, { ok: true, url: state.url }, `navigated to ${state.url}`);
  });
}

export async function cmdHistory(
  ctx: CommandContext,
  which: "back" | "forward" | "reload",
): Promise<string> {
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withPageClient(ctx, async (c) => {
    await c.request(which, []);
    const state = await c.request("state");
    await syncState(prev, state);
    const text = which === "reload" ? `reloaded ${state.url}` : `${which} -> ${state.url}`;
    return replyPage(ctx, c, { ok: true, url: state.url }, text);
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

const realProcess: ProcessOps = {
  alive: isAlive,
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
  return readPidFile(pidPath(session));
}

async function readPidFile(path: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
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
    // Still running after being asked to stop, or never reachable to ask.
    if (!(await proc.ours(pid, session))) {
      // Either the number was reused and our daemon is long gone, or the
      // process is ours and could not be identified. Those are not
      // distinguishable from here, and signalling on a guess is the one thing
      // this command must never do — so nothing is removed and nothing is
      // claimed. Deleting the pidfile is the way out of a reused number.
      throw new Error(
        `close: pid ${pid} recorded for session '${session}' is running but does not look ` +
          `like a bowser daemon; if it is unrelated, delete ${pidPath(session)} and retry`,
      );
    }
    proc.term(pid);
    ended = true;
    if (!(await waitGone(proc, pid))) {
      throw new Error(`close: daemon for session '${session}' (pid ${pid}) is still running`);
    }
  }

  // A concurrent `open` can start a replacement daemon while the steps above
  // are waiting. Removing the directory then deletes the newcomer's socket and
  // pidfile while it runs — the very orphan this command exists to prevent.
  const current = await readPid(session);
  if (current !== null && current !== pid && proc.alive(current)) {
    throw new Error(
      `close: session '${session}' was reopened while closing (pid ${current}); left it running`,
    );
  }

  // The directory outlives nothing now: keeping it is what let closed sessions
  // accumulate, and after close there is no state left in it worth reading.
  await rm(sessionDir(session), { recursive: true, force: true });

  const text = ended
    ? `closed session '${session}' (ended unreachable daemon ${pid})`
    : `closed session '${session}'`;
  return reply(ctx, { ok: true, session, ended }, text);
}

/** A directory under the sessions root whose name predates the naming rule,
 *  so `sessionDir` refuses it. The name came from `readdir` of the root, so the
 *  path cannot escape it. Its daemon cannot be reached (`socketPath` refuses the
 *  name too) or identified from `ps` (the name may hold spaces), so it is never
 *  signalled: a live recorded pid leaves the directory for a person. */
async function closeLegacy(name: string): Promise<void> {
  const dir = join(sessionsRoot(), name);
  const pid = await readPidFile(join(dir, "pid"));
  if (pid !== null && realProcess.alive(pid)) {
    throw new Error(`close: pid ${pid} recorded for legacy session ${JSON.stringify(name)} is running`);
  }
  // A legacy daemon may predate pidfiles. Its socket is not enough to identify
  // a process safely, but it is enough to avoid deleting the only path back to
  // one that may still be alive.
  if (pid === null && await Bun.file(join(dir, "sock")).exists()) {
    throw new Error(`close: legacy session ${JSON.stringify(name)} has no pidfile but still has a socket`);
  }
  await rm(dir, { recursive: true, force: true });
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
      await (isValidSessionName(name) ? closeOne(ctx, name) : closeLegacy(name));
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
    flags: [
      { name: "persistent", kind: "boolean" },
      { name: "profile", kind: "string" },
    ],
    run: (ctx, a) => cmdOpen(ctx, a.positional[0], {
      persistent: Boolean(a.flags.persistent),
      profile: str(a.flags, "profile"),
    }),
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
