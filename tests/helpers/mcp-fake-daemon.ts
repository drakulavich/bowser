// `bowser mcp` as the entry runs it (runMcpServer on this process's stdio),
// with every command connected to a fake daemon instead of a real one. The
// fake writes a screenshot where it is told, as the daemon does. Spawned by
// tests that need the server's own process: its cwd and its stdout.

import { run } from "../../src/cli.ts";
import { runMcpServer } from "../../src/mcp.ts";
import { fakeClient } from "./fake-client.ts";

await runMcpServer({ run: (argv) => run(argv, { connect: async () => fakeClient({}) }) });
