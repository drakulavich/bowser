// What every command shares: the context the CLI builds, the daemon
// connection with its close, the empty session state, and ref lookup.

import type { FlagSpec } from "../cli/parser.ts";
import { connectOrSpawn, type ConnectOptions } from "../daemon/client.ts";
import type { DaemonConnection, DialogReport, PageState } from "../daemon/protocol.ts";
import { resolveRefScript } from "../page-scripts.ts";
import { loadState, resolveRef, saveState, type Ref, type SessionState } from "../state.ts";
import { UserError } from "../errors.ts";

export interface CommandContext {
  session: string;
  json: boolean;
  /** The command being run; the daemon's timeout message names it (F21). */
  command?: string;
  // Injected in tests.
  connect?: (session: string, opts?: ConnectOptions) => Promise<DaemonConnection>;
  /** All of standard input, for `fill --stdin`. Defaults to `readStdin`;
   *  tests inject a fake. `bowser mcp` never reaches it: the flag is not in
   *  its schema and toArgv puts every client value after `--`. */
  readStdin?: () => Promise<string>;
}

interface Positional {
  name: string;
  required: boolean;
  /** Required in the MCP tool schema even though optional on the CLI: fill's
   *  <text>, which the CLI can replace with --stdin and MCP cannot. */
  mcpRequired?: true;
}
interface CommandArgs { positional: string[]; flags: Record<string, string | boolean> }

export interface Command {
  name: string;
  /** One line, imperative, no trailing period. Feeds `--help` and the MCP tool description. */
  summary: string;
  positional: Positional[];
  flags: FlagSpec[];
  /** The MCP tool description, when `summary` names something MCP does not
   *  offer (a flag marked `mcp: false`). Same rules as `summary`. */
  mcpSummary?: string;
  /** Omit from `bowser mcp`. Replaces MCP_EXCLUDED. */
  mcp?: false;
  run(ctx: CommandContext, args: CommandArgs): Promise<string>;
}

/** All of standard input as UTF-8. A terminal is refused rather than read:
 *  reading it would block until the user typed an end-of-file. */
export async function readStdin(
  stdin: { isTTY?: boolean } = process.stdin,
  read: () => Promise<string> = () => Bun.stdin.text(),
): Promise<string> {
  if (stdin.isTTY) {
    throw new UserError("usage: --stdin reads piped input, not a terminal: op read op://vault/item/password | bowser fill e4 --stdin");
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
  const client = await connector(ctx)(ctx.session, ctx.command ? { ...opts, command: ctx.command } : opts);
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
  if (!prev) throw new UserError("no open page. Run 'bowser open <url>' first.");
  return { prev, target: resolveRef(prev, ref), doc: prev.doc };
}

/** The selector of the ref's element in the live page, computed now. A ref
 *  from another document than `doc`, the one its snapshot ran in, fails here
 *  (#105). The resolve waits for a pending navigation, so it runs in the
 *  document the action will land in. A ref whose element is
 *  gone fails before any action with playwright-cli's message; acting on the saved
 *  selector instead would wait out the op timeout or hit whatever element
 *  moved into its place. So does one whose element's role or name changed
 *  since the snapshot (#80). With `enabled`, a disabled element fails too, at
 *  once, and nothing is clicked (F20). One daemon round trip. */
export async function liveSelector(c: DaemonConnection, target: Ref, opts: { enabled?: boolean; doc?: string } = {}): Promise<string> {
  const ref = target.id;
  const selector = await c.request("resolve", [resolveRefScript(target, opts)]);
  if ((selector as { gone?: unknown } | null)?.gone === true) {
    throw new UserError(`ref '${ref}' is from a page that is no longer loaded; take a new snapshot`);
  }
  const changed = (selector as { changed?: { role: string; name: string } } | null)?.changed;
  if (changed) {
    throw new UserError(
      `ref '${ref}' now points to ${changed.role} ${JSON.stringify(changed.name)}, not ${target.role} ${JSON.stringify(target.name)}; take a new snapshot`,
    );
  }
  if (opts.enabled && (selector as { disabled?: unknown } | null)?.disabled === true) {
    throw new UserError(`ref '${ref}' is disabled`);
  }
  if (typeof selector !== "string") {
    throw new UserError(`ref '${ref}' not found in the current page snapshot. Try capturing new snapshot.`);
  }
  return selector;
}

/** Every command answers the same way: a JSON object under --json, a line
 *  otherwise. The object is stringified here so all commands agree on it. */
export function reply(ctx: CommandContext, json: Record<string, unknown>, text: string): string {
  return ctx.json ? JSON.stringify(json) : text;
}

/** One answered dialog, as `["confirm" dialog with message "sure?"]: accepted`. */
function dialogLine(d: DialogReport): string {
  // No hint for an alert: accepting and dismissing it are the same.
  const what = d.unanswered && d.type !== "alert" ? "dismissed (run dialog-accept before the action to accept it)" : d.state;
  return `[${JSON.stringify(d.type)} dialog with message ${JSON.stringify(d.message)}]: ${what}`;
}

/** `reply` for a command that acts on the page: the dialogs the daemon
 *  answered while it ran follow the answer as playwright-cli's
 *  `### Modal state` (`dialogs` under --json, without `unanswered`). */
export function replyPage(ctx: CommandContext, c: DaemonConnection, json: Record<string, unknown>, text: string): string {
  const modal = modalState(c);
  if (!modal) return reply(ctx, json, text);
  return reply(ctx, { ...json, dialogs: dialogsJson(c) }, `${text}\n${modal}`);
}

/** The `### Modal state` section for the dialogs `c` reported, or "". */
export function modalState(c: DaemonConnection): string {
  return modalLines(c.dialogs());
}

function modalLines(dialogs: DialogReport[]): string {
  return dialogs.length ? ["### Modal state", ...dialogs.map((d) => `- ${dialogLine(d)}`)].join("\n") : "";
}

/** The `### Modal state` section of a failed page command: the dialogs
 *  answered while it ran, which `withPageClient` hangs on its error; or "". */
export function failedModalState(err: unknown): string {
  const dialogs = err instanceof Error ? (err as Error & { dialogs?: DialogReport[] }).dialogs : undefined;
  return Array.isArray(dialogs) ? modalLines(dialogs) : "";
}

/** The reported dialogs as --json gives them: without `unanswered`. */
export function dialogsJson(c: DaemonConnection): Omit<DialogReport, "unanswered">[] {
  return c.dialogs().map(({ unanswered: _, ...d }) => d);
}

/** `withClient` for a command that prints the dialogs the daemon answered
 *  (through `replyPage` or `modalState`): only such a command takes them,
 *  so a report is never lost to one that would not print it. */
export function withPageClient<T>(
  ctx: CommandContext,
  fn: (c: DaemonConnection) => Promise<T>,
  opts: ConnectOptions = {},
): Promise<T> {
  return withClient(ctx, async (c) => {
    c.reportDialogs();
    try {
      return await fn(c);
    } catch (err) {
      // The daemon handed this command its reports, so they are printed with
      // the error or never: the error stays the same object (its class sets
      // the exit code), and the dialogs ride along on it.
      const dialogs = c.dialogs();
      if (dialogs.length === 0) throw err;
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { dialogs });
    }
  }, opts);
}

/** After an action that may have navigated, persist the page the daemon
 *  reports while keeping the session's refs. */
export async function syncState(prev: SessionState, state: PageState): Promise<void> {
  await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
}
