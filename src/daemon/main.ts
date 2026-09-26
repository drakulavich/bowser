#!/usr/bin/env bun
// Entry point for the spawned daemon process. Keeps a single Bun.WebView alive
// and services requests until told to shut down.

import { DAEMON_PROFILE_ENV } from "./client.ts";
import { startDaemon } from "./server.ts";

const session = process.argv[2];
if (!session) {
  console.error("daemon: missing session name");
  process.exit(1);
}

// false: another daemon of ours holds the session; this one leaves it alone.
if (!(await startDaemon(session, process.env[DAEMON_PROFILE_ENV] || undefined))) process.exit(0);
