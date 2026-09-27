// A stand-in daemon on a session's real socket, for tests of what the CLI
// does with the daemon it finds there: an older one after an upgrade (F2), a
// silent one (F3), and the timing of `list` (F32). It records every op it
// receives. `answer` returns the reply's result, or `SILENT` to never reply.

import { ensureSessionDir } from "../../src/state.ts";
import { socketPath } from "../../src/daemon/client.ts";

export const SILENT = Symbol("silent");

export interface FakeDaemon {
  ops: string[];
  stop(): void;
}

type Answer = (req: { id: number; op: string; args?: unknown[] }) => unknown;

export async function fakeDaemon(session: string, answer: Answer): Promise<FakeDaemon> {
  await ensureSessionDir(session);
  const ops: string[] = [];
  let buf = "";
  const server = Bun.listen({
    unix: socketPath(session),
    socket: {
      data(s, data) {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const req = JSON.parse(line) as { id: number; op: string; args?: unknown[] };
          ops.push(req.op);
          const result = answer(req);
          if (result === SILENT) continue;
          s.write(JSON.stringify(result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result }) + "\n");
        }
      },
    },
  });
  return { ops, stop: () => server.stop(true) };
}

/** A daemon of a given version: `ping` answers `version` ("pong" is every
 *  daemon before 0.8), `state` a blank page, `evaluate` 1. */
export function daemonOf(version: string): Answer {
  return (req) => (req.op === "ping" ? version : req.op === "state" ? { url: "about:blank", title: "" } : req.op === "evaluate" ? 1 : undefined);
}
