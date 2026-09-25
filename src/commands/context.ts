// What every command shares: the context the CLI builds, the daemon
// connection with its close, the empty session state, and ref lookup.

import { connectOrSpawn } from "../daemon/client.ts";
import type { DaemonConnection, PageState } from "../daemon/protocol.ts";
import { resolveRefScript } from "../page-scripts.ts";
import { loadState, resolveRef, saveState, type SessionState } from "../state.ts";

export interface CommandContext {
  session: string;
  json: boolean;
  // Injected in tests.
  connect?: (session: string, opts?: { spawn?: boolean }) => Promise<DaemonConnection>;
}

export function connector(ctx: CommandContext): (session: string, opts?: { spawn?: boolean }) => Promise<DaemonConnection> {
  return ctx.connect ?? connectOrSpawn;
}

export async function withClient<T>(
  ctx: CommandContext,
  fn: (c: DaemonConnection) => Promise<T>,
  opts: { spawn?: boolean } = {},
): Promise<T> {
  const client = await connector(ctx)(ctx.session, opts);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export function emptyState(name: string): SessionState {
  return { name, url: "", title: "", refs: [], updatedAt: 0 };
}

export async function loadRef(session: string, ref: string) {
  const prev = await loadState(session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  return { prev, target: resolveRef(prev, ref) };
}

/** The selector of the ref's element in the live page, computed now. A ref
 *  whose element is gone (removed, or from a previous document) fails here,
 *  before any action, with playwright-cli's message; acting on the saved
 *  selector instead would wait out the op timeout or hit whatever element
 *  moved into its place. One daemon round trip. */
export async function liveSelector(c: DaemonConnection, ref: string): Promise<string> {
  const selector = await c.request("evaluate", [resolveRefScript(ref)]);
  if (typeof selector !== "string") {
    throw new Error(`ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`);
  }
  return selector;
}

/** Every command answers the same way: a JSON object under --json, a line
 *  otherwise. The object is stringified here so all commands agree on it. */
export function reply(ctx: CommandContext, json: Record<string, unknown>, text: string): string {
  return ctx.json ? JSON.stringify(json) : text;
}

/** After an action that may have navigated, persist the page the daemon
 *  reports while keeping the session's refs. */
export async function syncState(prev: SessionState, state: PageState): Promise<void> {
  await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
}
