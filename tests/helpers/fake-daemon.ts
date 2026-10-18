// A stand-in daemon on a session's real socket, for tests of what the CLI
// does with the daemon it finds there: an older one after an upgrade (F2), a
// silent one (F3), and the timing of `list` (F32). It records every op it
// receives. `answer` returns the reply's result, `SILENT` to never reply, or
// an error reply (`{ ok: false, error }`), written as is; or a promise of one.

import type { Socket, SocketHandler } from "bun";
import { ensureSessionDir } from "../../src/state.ts";
import { socketPath } from "../../src/daemon/client.ts";
import { lineReader } from "../../src/socket-lines.ts";
import type { DaemonResponse, Op, ResultOf } from "../../src/daemon/protocol.ts";

export const SILENT = Symbol("silent");

export interface FakeDaemon {
  ops: string[];
  stop(): void;
}

type Request = { id: number; op: Op; args?: unknown[] };
export type Answer = (req: Request) => unknown;

function reply(s: LineSocket, id: number, result: unknown): void {
  if (result === SILENT) return;
  const failed = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
  const res: DaemonResponse = failed ? { id, ...(result as { ok: false; error: string }) } : result === undefined ? { id, ok: true } : { id, ok: true, result };
  s.write(JSON.stringify(res) + "\n");
}

export async function fakeDaemon(session: string, answer: Answer): Promise<FakeDaemon> {
  await ensureSessionDir(session);
  const ops: string[] = [];
  const server = Bun.listen({
    unix: socketPath(session),
    socket: lineSocket((s, line) => {
      const req = JSON.parse(line) as Request;
      ops.push(req.op);
      const result = answer(req);
      // Written at once when not a promise: `upgrade` stops the daemon in a
      // microtask right after its `shutdown` reply.
      if (result instanceof Promise) void result.then((r) => reply(s, req.id, r));
      else reply(s, req.id, result);
    }),
  });
  return { ops, stop: () => server.stop(true) };
}

type LineSocket = Socket<(chunk: Uint8Array) => void>;

/** Socket handlers that call `onLine` with each non-empty line a connection
 *  sends, decoded as a stream the way the daemon does (#75). */
export function lineSocket(onLine: (s: LineSocket, line: string) => void): SocketHandler<(chunk: Uint8Array) => void> {
  return {
    open(s) {
      s.data = lineReader((line) => { if (line) onLine(s, line); });
    },
    data(s, chunk) {
      s.data(chunk);
    },
  };
}

/** A daemon of a given version: `ping` answers `version` ("pong" is every
 *  daemon through 0.7), `state` a blank page, `evaluate` 1. */
export function daemonOf(version: string): Answer {
  return (req) => (req.op === "ping" ? version satisfies ResultOf<"ping">
    : req.op === "state" ? { url: "about:blank", title: "" } satisfies ResultOf<"state">
    : req.op === "evaluate" ? 1 : undefined);
}
