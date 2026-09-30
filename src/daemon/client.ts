// Client side of the daemon protocol: connect to a session's Unix socket (or
// spawn the daemon first), send typed requests, match replies by id.

import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json";
import { opTimeoutMs } from "../budget.ts";
import { withTimeout } from "../serialize.ts";
import { lineReader } from "../socket-lines.ts";
import { flushSocket, socketWriteAll, type WritableSocket } from "../socket-write.ts";
import { checkNewSessionName, loadState, profileDir, sessionDir, statePath } from "../state.ts";
import type { DaemonConnection, DaemonResponse, DialogReport, Op, RequestParams, ResultOf } from "./protocol.ts";
import { UserError } from "../errors.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  // sessionDir() is what validates the name; going through it is what keeps a
  // traversing session name out of every path bowser builds.
  return join(sessionDir(session), "sock");
}

/** Where the daemon records its own pid, beside its socket. `close` needs it
 *  to confirm the process actually died: an unreachable daemon has no socket
 *  to ask, so without this the only honest answer is "something may still be
 *  running". */
export function pidPath(session: string): string {
  return join(sessionDir(session), "pid");
}

export class DaemonClient implements DaemonConnection {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();
  private closed = false;
  private reported: DialogReport[] = [];
  private report = false;
  private start: number | undefined;

  constructor(
    private readonly path: string,
    private readonly session: string,
    /** The command the user ran, sent with each request so a timeout can
     *  name it (F21). */
    private readonly command?: string,
  ) {}

  private get closedMessage(): string {
    return `daemon for session '${this.session}' closed the connection`;
  }

  /** The socket is gone, whoever closed it: nothing pending will ever get a
   *  reply, so fail it all now instead of leaving the caller hanging. */
  private markClosed(message = this.closedMessage): void {
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of waiting) reject(new Error(message));
  }

  async connect(): Promise<void> {
    const self = this;
    const read = lineReader((line) => {
      if (!line) return;
      try {
        const res = JSON.parse(line) as DaemonResponse;
        const entry = self.pending.get(res.id);
        if (entry) {
          if (res.dialogs) self.reported.push(...res.dialogs);
          self.pending.delete(res.id);
          if (res.ok) entry.resolve(res.result);
          else entry.reject(new Error(res.error ?? "daemon error"));
        }
      } catch {
        // swallow
      }
    });
    this.sock = await Bun.connect({
      unix: this.path,
      socket: {
        data(_s, data) {
          read(data);
        },
        drain(s) {
          flushSocket(s as unknown as WritableSocket);
        },
        end() {
          self.markClosed();
        },
        close() {
          self.markClosed();
        },
        error(_s, err) {
          self.markClosed(`${self.closedMessage}: ${err.message}`);
        },
      },
    });
  }

  dialogs(): DialogReport[] {
    return [...this.reported];
  }

  reportDialogs(): void {
    this.report = true;
  }

  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>> {
    const [op, args = []] = params;
    if (!this.sock) throw new Error("client not connected");
    if (this.closed) return Promise.reject(new Error(this.closedMessage));
    const id = this.nextId++;
    const budget = opTimeoutMs();
    if (op !== "ping") this.start ??= Date.now();
    const line = JSON.stringify({
      id, op, args,
      ...(this.report ? { report: true } : {}),
      ...(this.command ? { cmd: this.command } : {}),
      ...(budget > 0 && this.start !== undefined ? { budgetMs: budget - (Date.now() - this.start), budgetTotalMs: budget } : {}),
    }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as ResultOf<O>), reject });
      socketWriteAll(this.sock! as unknown as WritableSocket, line);
    });
  }

  close(): void {
    this.sock?.end();
    this.markClosed();
  }
}

/** How long a daemon has to answer the health check before it counts as
 *  unreachable. It answers in microseconds when it is alive at all: `ping` is
 *  on the daemon's urgent lane, so even a busy one replies immediately. */
const HEALTH_PING_MS = 1000;

/** How a command reaches its daemon. `spawn: false` refuses to start one;
 *  `profile` is the persistent store a daemon spawned now opens with (a
 *  running daemon keeps the store it started with). */
export interface ConnectOptions {
  spawn?: boolean;
  profile?: string;
  /** The platform a daemon would run on; `process.platform` unless a test
   *  fakes it. */
  platform?: string;
  /** The Bun a daemon would run on; the running one unless a test fakes it. */
  runtime?: BunRuntime;
  /** Start a daemon even where one ran and exited. Only `open` sets it: every
   *  other command refuses such a session (F28). */
  reopen?: boolean;
  /** Accept a daemon of another bowser version. Only `close` and `list` set
   *  it: they must still reach a daemon left running by an upgrade (F2). */
  anyVersion?: boolean;
  /** The command the user ran; a timeout names it (F21). */
  command?: string;
  /** The bowser version installed on disk now; a test fakes it. */
  installedVersion?: () => Promise<string | undefined>;
}

/** A daemon whose socket accepted the connection and never answered the
 *  health check: stopped, or blocked in a syscall. Unlike a refused
 *  connection, it is still running, so `close` must not treat its socket as
 *  stale (F3). */
export class DaemonNotAnswering extends Error {
  constructor(session: string) {
    super(`daemon for session '${session}' did not answer; run 'bowser close -s ${session}' to stop it`);
  }
}

/** Why a command refuses a daemon of another bowser version, found running
 *  after an upgrade: its ops and their behaviour may differ from this CLI's,
 *  and restarting it quietly would drop its page (F2). A user error (exit 1).
 *  `answer` is what it said to `ping`: its version, or "pong" from every
 *  daemon before the version was sent. */
async function otherVersion(session: string, answer: unknown, opts: ConnectOptions): Promise<string> {
  // A daemon is spawned from the files on disk, so after an in-place upgrade a
  // long-running process (`bowser mcp`) meets its own new daemon here.
  const installed = await (opts.installedVersion ?? installedVersion)();
  if (installed === answer && installed !== pkg.version) {
    return `this bowser (${pkg.version}) is older than the installed bowser (${installed}); restart the MCP server or re-run the command`;
  }
  const v = typeof answer === "string" && /^\d+\.\d+\.\d+/.test(answer) ? answer : "an older version";
  const cmd = await openCommand(session);
  const open = cmd === "bowser open" ? "open it again" : `open it again with '${cmd}'`;
  return `session '${session}' is running bowser ${v} (this is ${pkg.version}); run 'bowser close -s ${session}', then ${open}`;
}

/** undefined where package.json is not on disk (a compiled binary). */
async function installedVersion(): Promise<string | undefined> {
  try {
    return (await Bun.file(new URL("../../package.json", import.meta.url)).json()).version;
  } catch {
    return undefined;
  }
}

/** The client, once its daemon has answered `ping` with `answer`; refused
 *  when the daemon is of another version, unless `opts.anyVersion`. */
async function checked(client: DaemonClient, session: string, answer: unknown, opts: ConnectOptions): Promise<DaemonClient> {
  if (opts.anyVersion || answer === pkg.version) return client;
  client.close();
  throw new UserError(await otherVersion(session, answer, opts));
}

/** Why a command refuses a session whose daemon ran and is gone: its page,
 *  refs and, for `--persistent`, its store went with it, and a new daemon
 *  started quietly would be an empty in-memory browser. A user error (exit 1). */
async function browserExited(session: string): Promise<string> {
  return `session '${session}' is not open (its browser exited); run '${await openCommand(session)}'`;
}

/** State from an older bowser has no profile record: a directory on disk decides. */
async function openCommand(session: string): Promise<string> {
  const profile = (await loadState(session))?.profile;
  if (profile === undefined) return existsSync(profileDir(session)) ? "bowser open --persistent" : "bowser open";
  if (profile === null) return "bowser open";
  return profile === profileDir(session) ? "bowser open --persistent" : `bowser open --profile=${profile}`;
}

/** Why bowser cannot start a daemon off macOS: its only engine is WebKit's
 *  Bun.WebView, which throws on other platforms. A user error (exit 1). */
const REQUIRES_MACOS = "bowser requires macOS (WebKit)";

/** What the Bun guard looks at in the running Bun. */
interface BunRuntime {
  version: string;
  webView: boolean;
}

/** Why bowser refuses a Bun below `engines.bun`, or one without Bun.WebView:
 *  npm does not enforce `engines.bun`, and on such a Bun the daemon would die
 *  unseen. A user error (exit 1). The floor is read from package.json, so the
 *  message follows it. */
function unsupportedBun(runtime: BunRuntime): string | undefined {
  const floor = pkg.engines.bun;
  if (runtime.webView && Bun.semver.satisfies(runtime.version, floor)) return undefined;
  return `bowser requires Bun ${floor} (found ${runtime.version})`;
}

/** The environment variable that carries the profile to a spawned daemon.
 *  Env rather than argv: `looksLikeOurDaemon` identifies a daemon by its last
 *  two argv words. */
export const DAEMON_PROFILE_ENV = "BOWSER_DAEMON_PROFILE";

/** Connect to a session's daemon, or spawn one if it isn't running. */
export async function connectOrSpawn(
  session: string,
  opts: ConnectOptions = {},
): Promise<DaemonClient> {
  const sock = socketPath(session);
  const client = new DaemonClient(sock, session, opts.command);
  let connected = false;
  let answer: unknown;
  try {
    await client.connect();
    connected = true;
    // Bound the health check. A daemon that accepts the connection and never
    // answers — stopped, or blocked in a syscall — would otherwise hang every
    // caller forever, `list` included. Treating it as unreachable is what the
    // callers already know how to handle.
    answer = await withTimeout(client.request("ping"), HEALTH_PING_MS, "ping");
  } catch {
    // Close before falling through: a connected socket that is never closed
    // keeps the process alive after the command has printed its answer.
    client.close();
    // Do not replace a daemon whose socket accepted our connection but whose
    // health check timed out. Unlinking its socket and spawning another daemon
    // would leave two browser processes for one session, while the old one
    // would no longer be addressable by its pidfile. Reported before the
    // spawn: false case, so `close` can tell it from a stale socket (F3).
    if (connected) throw new DaemonNotAnswering(session);
    if (opts.spawn === false) throw new Error(`no daemon for session '${session}'`);
    // A daemon ran here (it left state.json) and none answers now: its
    // browser exited. Only `open` may start another; `close` never spawns.
    // A fresh session has no state.json and still spawns lazily.
    if (!opts.reopen && (await Bun.file(statePath(session)).exists())) throw new UserError(await browserExited(session));
    // Before the spawn guards: a daemon under a name too long for this HOME
    // would die claiming its pidfile, seen only as "did not start in time" (F35).
    checkNewSessionName(session);
    // The one platform check. The daemon opens its WebView before it opens its
    // socket, so off macOS it would die unseen, and the caller would get only
    // the "did not start in time" timeout below. Refuse with the real reason.
    if ((opts.platform ?? process.platform) !== "darwin") throw new UserError(REQUIRES_MACOS);
    // The Bun guard, for the same reason: the daemon would die unseen.
    const bunError = unsupportedBun(opts.runtime ?? { version: Bun.version, webView: typeof Bun.WebView === "function" });
    if (bunError) throw new UserError(bunError);
    await spawnDaemon(session, opts.profile);
    // Poll until the socket is listening.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const c = new DaemonClient(sock, session, opts.command);
      let reply: unknown;
      try {
        await c.connect();
        reply = await withTimeout(c.request("ping"), HEALTH_PING_MS, "ping");
      } catch {
        c.close();
        await Bun.sleep(50);
        continue;
      }
      return checked(c, session, reply, opts);
    }
    // A daemon that dies opening its browser never reaches its socket, so its
    // error is invisible here. A persistent store is the likely cause when one
    // was asked for (WebKit needs macOS 15.2+ for it), so say so.
    const hint = opts.profile
      ? ` with --persistent profile ${opts.profile}; the browser may not support a persistent profile here`
      : "";
    const log = process.env.BOWSER_DAEMON_DEBUG === "1" ? `; its output is in ${daemonLogPath(session)}` : "";
    throw new Error(`daemon for session '${session}' did not start in time${hint}${log}`);
  }
  // Checked outside the try: its refusal must not fall into the spawn path.
  return checked(client, session, answer, opts);
}

/** The argv a spawned daemon runs with. Always `bun <package>/src/daemon/main.ts
 *  <session>`: from a checkout and from an npm install alike, main.ts sits
 *  beside this file. `looksLikeOurDaemon` must recognise it (tests/daemon.test.ts
 *  pins the round trip): a form it cannot read makes a live daemon look stale. */
export function daemonCommand(session: string): string[] {
  return [process.execPath, new URL("./main.ts", import.meta.url).pathname, session];
}

async function spawnDaemon(session: string, profile?: string): Promise<void> {
  const { ensureSessionDir } = await import("../state.ts");
  await ensureSessionDir(session);
  // Create the profile here, in the CLI, and only for a daemon about to be
  // spawned: no daemon runs, so there is no store conflict to refuse and
  // nothing is left behind by a refused open. A failure (permissions, a file
  // in the way) is reported now, with its cause; inside the daemon it would
  // only show up as a startup timeout.
  if (profile) {
    try {
      await mkdir(profile, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot create profile directory ${profile}: ${msg}`);
    }
  }

  const cmd = daemonCommand(session);

  // When BOWSER_DAEMON_DEBUG is set, the daemon's stdout and stderr go to
  // daemon.log in the session directory, so spawn failures are diagnosable.
  // Never to our own descriptors: the daemon outlives this process and would
  // hold the caller's pipe open, so `bowser … | cat` never saw EOF (F6).
  // Appended, so a daemon that loses the session claim keeps the winner's log.
  const debug = process.env.BOWSER_DAEMON_DEBUG === "1";
  const stdio: "ignore" | number = debug ? openSync(daemonLogPath(session), "a") : "ignore";

  const proc = Bun.spawn({
    cmd,
    stdout: stdio,
    stderr: stdio,
    stdin: "ignore",
    // Pass the LIVE process.env. Without an explicit `env`, Bun.spawn inherits
    // the OS environment block captured at *this* process's startup and ignores
    // runtime mutations of process.env — so a redirected HOME (set after launch,
    // e.g. by the e2e tests' beforeAll) would NOT reach the daemon.
    env: daemonEnv(profile),
  });
  // Don't let the spawned daemon keep THIS process alive. Bun keeps the parent's
  // event loop open until a child exits — but the daemon runs forever (keepalive
  // interval), so without unref() a daemon-spawning command (e.g. `bowser open`
  // on a fresh session) prints its result and then hangs indefinitely instead of
  // returning to the shell. Measured from source: without it, `bun src/cli.ts
  // open <url>` printed `opened …` and hung until killed. `bun test` masks this
  // (the runner force-exits); tests/e2e-spawn-exit.test.ts runs the CLI as its
  // own process and fails without it.
  proc.unref();
  // The child has its own copy of the descriptor.
  if (typeof stdio === "number") closeSync(stdio);
}

/** Where a daemon spawned with BOWSER_DAEMON_DEBUG=1 writes its stdout and
 *  stderr. `close` deletes it with the session directory. */
export function daemonLogPath(session: string): string {
  return join(sessionDir(session), "daemon.log");
}

/** The daemon's environment: ours, with the profile set or cleared so a stale
 *  value inherited from the caller never picks the store. */
function daemonEnv(profile: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (profile) env[DAEMON_PROFILE_ENV] = profile;
  else delete env[DAEMON_PROFILE_ENV];
  return env;
}
