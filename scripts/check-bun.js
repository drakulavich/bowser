#!/usr/bin/env node
// Preinstall check: Bowser runs on Bun (it uses Bun.WebView, Bun.spawn,
// Bun.serve, and other Bun-only APIs). We can't run under Node, so warn
// clearly at install time if Bun isn't on PATH.
//
// Note: this script is invoked by npm/pnpm/yarn with Node, not Bun. Keep it
// plain CommonJS with no Bun imports.

"use strict";

const { execSync } = require("node:child_process");

function hasBun() {
  try {
    const out = execSync("bun --version", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || true;
  } catch {
    return false;
  }
}

const version = hasBun();
if (!version) {
  const yellow = "\x1b[33m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  // eslint-disable-next-line no-console
  console.warn(`
${yellow}${bold}⚠  Bowser requires Bun ≥ 1.3.12${reset}
${yellow}   Bun was not found on your PATH. Install it first:${reset}

     curl -fsSL https://bun.sh/install | bash

   Then re-run your install command. Bowser will not work under Node.js.
`);
  // Exit 0 so we don't block the install — the user may be installing for
  // later use on another machine, or Bun may be installed but not on PATH in
  // this shell. The warning is loud enough.
  process.exit(0);
}
