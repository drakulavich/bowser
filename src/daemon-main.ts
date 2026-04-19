#!/usr/bin/env bun
// Entry point for the spawned daemon process. Keeps a single Bun.WebView alive
// and services requests until told to shut down.

import { startDaemon } from "./daemon.ts";

const session = process.argv[2];
if (!session) {
  console.error("daemon-main: missing session name");
  process.exit(1);
}

await startDaemon(session);
