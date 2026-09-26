// What every command shares: the context the CLI builds, the daemon
// connection with its close, the empty session state, and ref lookup.

import { connectOrSpawn, type ConnectOptions } from "../daemon/client.ts";
import type { DaemonConnection, DialogReport, PageState } from "../daemon/protocol.ts";
import { resolveRefScript } from "../page-scripts.ts";
import { loadState, resolveRef, saveState, type SessionState } from "../state.ts";

export interface CommandContext {
  session: string;
  json: boolean;
  // Injected in tests.
  connect?: (session: string, opts?: ConnectOptions) => Promise<DaemonConnection>;
  /** All of standard input, for `fill --stdin`. Defaults to `readStdin`;
   *  tests inject a fake. `bowser mcp` never reaches it: the flag is not in
   *  its schema and toArgv puts every client value after `--`. */
  readStdin?: () => Promise<string>;
}

/** All of standard input as UTF-8. A terminal is refused rather than read:
 *  reading it would block until the user typed an end-of-file. */
export async function readStdin(
  stdin: { isTTY?: boolean } = process.stdin,
  read: () => Promise<string> = () => Bun.stdin.text(),
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error("usage: --stdin reads piped input, not a terminal: op read op://vault/item/password | bowser fill e4 --stdin");
  }
  return read();
}

export function connector(ctx: CommandContext): (session: string, opts?: ConnectOptions) => Promise<DaemonConnection> {
  return ctx.connect ?? connectOrSpawn;
}

export async function withClient<T>(
  ctx: CommandContext,
  fn: (c: DaemonConnection) => Promise<T>,
  opts: ConnectOptions = {},
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

/** The `### Modal state` section for the dialogs a command saw, as
 *  playwright-cli prints it. */
export function modalState(dialogs: DialogReport[]): string {
  return ["### Modal state", ...dialogs.map((d) => `- ${dialogLine(d)}`)].join("\n");
}

/** One dialog, as `["confirm" dialog with message "sure?"]: <what happened>`. */
export function dialogLine(d: DialogReport): string {
  const what = d.state === "pending"
    ? "can be handled by dialog-accept or dialog-dismiss"
    : d.unanswered ? "dismissed (run dialog-accept before the action to accept it)" : d.state;
  return `[${JSON.stringify(d.type)} dialog with message ${JSON.stringify(d.message)}]: ${what}`;
}

/** A dialog as --json reports it: the wire report without `unanswered`. */
export function dialogJson({ unanswered: _, ...d }: DialogReport): Omit<DialogReport, "unanswered"> {
  return d;
}

/** True when the page has a dialog open that blocks further actions. */
export function dialogPending(c: DaemonConnection): boolean {
  return c.dialogs().some((d) => d.state === "pending");
}

/** `reply` for a command that acts on the page: any dialog it opened or the
 *  daemon answered follows the answer (`dialogs` under --json). */
export function replyPage(ctx: CommandContext, c: DaemonConnection, json: Record<string, unknown>, text: string): string {
  const dialogs = c.dialogs();
  if (dialogs.length === 0) return reply(ctx, json, text);
  return reply(ctx, { ...json, dialogs: dialogs.map(dialogJson) }, `${text}\n${modalState(dialogs)}`);
}

/** After an action that may have navigated, persist the page the daemon
 *  reports while keeping the session's refs. */
export async function syncState(prev: SessionState, state: PageState): Promise<void> {
  await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
}
