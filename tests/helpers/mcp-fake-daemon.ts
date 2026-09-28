// `bowser mcp` as the entry runs it (runMcpServer on this process's stdio),
// with every command connected to a fake daemon instead of a real one. The
// fake writes a screenshot where it is told, as the daemon does. Spawned by
// tests that need the server's own process: its cwd and its stdout.
//
// With MCP_FAKE_EVAL_LOG set, every `evaluate` appends its expression and a
// newline to that file as it starts, then waits MCP_FAKE_EVAL_MS (default 0)
// before it answers: a test can see which calls ran, and hold one open.

import { appendFileSync } from "node:fs";
import { run } from "../../src/cli.ts";
import { runMcpServer } from "../../src/mcp.ts";
import { fakeClient } from "./fake-client.ts";

const log = process.env.MCP_FAKE_EVAL_LOG;
const delay = Number(process.env.MCP_FAKE_EVAL_MS ?? 0);
const handlers = log
  ? {
      evaluate: async (expr: string) => {
        appendFileSync(log, expr + "\n");
        await Bun.sleep(delay);
        return expr;
      },
    }
  : {};

await runMcpServer({ run: (argv) => run(argv, { connect: async () => fakeClient(handlers) }) });
