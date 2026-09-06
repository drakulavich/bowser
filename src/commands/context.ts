// What every command shares: the context the CLI builds, the daemon
// connection with its close, the empty session state, and ref lookup.

import { connectOrSpawn } from "../daemon/client.ts";
import type { DaemonConnection } from "../daemon/protocol.ts";
import { loadState, resolveRef, type SessionState } from "../state.ts";

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
