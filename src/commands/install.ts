// `bowser install`: fetch a headless Chromium into bowser's own cache.

import { mkdir } from "node:fs/promises";
import { bowserCacheRoot, detectChromium } from "../backend.ts";
import type { Command } from "../cli/registry.ts";
import { reply, type CommandContext } from "./context.ts";

/** Download a headless Chromium build into ~/.bowser/chromium. We delegate
 *  the actual download to Playwright's installer (proven, cross-platform,
 *  checksummed) but redirect its output into our own cache via
 *  PLAYWRIGHT_BROWSERS_PATH so we don't touch the user's Playwright install. */
export interface InstallOptions {
  /** Run the installer even if a chromium is already detected. */
  force?: boolean;
  /** Swap stdio (for tests). Default: inherit so the user sees download progress. */
  spawn?: (cmd: string[], env: Record<string, string>) => Promise<number>;
  /** Override chromium detection (for tests). */
  detect?: () => string | undefined;
}

export async function cmdInstall(
  ctx: CommandContext,
  opts: InstallOptions = {},
): Promise<string> {
  const detect = opts.detect ?? detectChromium;
  const existing = detect();
  if (existing && !opts.force) {
    const msg = `chromium already available at ${existing} (use --force to reinstall)`;
    return reply(ctx, { ok: true, path: existing, skipped: true }, msg);
  }

  const cacheRoot = bowserCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PLAYWRIGHT_BROWSERS_PATH: cacheRoot,
  };

  const cmd = [
    "bunx",
    "--bun",
    "playwright",
    "install",
    "--only-shell",
    "chromium",
  ];

  const spawnFn =
    opts.spawn ??
    (async (c, e) => {
      const p = Bun.spawn({ cmd: c, env: e, stdout: "inherit", stderr: "inherit" });
      return await p.exited;
    });

  const code = await spawnFn(cmd, env);
  if (code !== 0) {
    throw new Error(`playwright install exited with code ${code}`);
  }

  const path = detect();
  if (!path) {
    throw new Error(
      `install finished but no chromium binary was found under ${cacheRoot}`,
    );
  }

  return reply(ctx, { ok: true, path }, `installed chromium to ${path}`);
}

export const COMMANDS: Command[] = [
  {
    name: "install",
    summary: "Download a headless Chromium",
    positional: [],
    flags: [{ name: "force", short: "f", kind: "boolean" }],
    mcp: false,
    run: (ctx, a) => cmdInstall(ctx, { force: Boolean(a.flags.force) }),
  },
];
