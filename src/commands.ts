// Command implementations. Each command connects to (or spawns) a per-session
// daemon that holds a persistent Bun.WebView. This is what lets stateful flows
// work — typed text, modals, and dynamic DOM all survive between commands.

import { bowserCacheRoot, detectChromium } from "./browser.ts";
import { connectOrSpawn, socketPath, type DaemonClient } from "./daemon.ts";
import { toJson, toYaml, SNAPSHOT_SCRIPT, type SnapshotResult } from "./snapshot.ts";
import {
  ensureSessionDir,
  loadState,
  resolveRef,
  saveState,
  type SessionState,
} from "./state.ts";
import { mkdir, unlink } from "node:fs/promises";

export interface CommandContext {
  session: string;
  json: boolean;
  flags: Record<string, string | boolean>;
  // Injected in tests.
  connect?: typeof connectOrSpawn;
}

function connector(ctx: CommandContext): typeof connectOrSpawn {
  return ctx.connect ?? connectOrSpawn;
}

async function withClient<T>(
  ctx: CommandContext,
  fn: (c: DaemonClient) => Promise<T>,
  opts: { spawn?: boolean } = {},
): Promise<T> {
  const client = await connector(ctx)(ctx.session, opts);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export async function cmdOpen(ctx: CommandContext, url?: string): Promise<string> {
  await ensureSessionDir(ctx.session);
  return withClient(ctx, async (c) => {
    if (url) await c.request("navigate", [url]);
    const state = (await c.request("state")) as { url: string; title: string };
    const next: SessionState = {
      name: ctx.session, url: state.url, title: state.title, refs: [], updatedAt: Date.now(),
    };
    await saveState(next);
    return ctx.json
      ? JSON.stringify({ ok: true, url: state.url, title: state.title })
      : (url ? `opened ${state.url}  "${state.title}"` : `session '${ctx.session}' ready`);
  });
}

export async function cmdGoto(ctx: CommandContext, url: string): Promise<string> {
  if (!url) throw new Error("usage: bowser goto <url>");
  return withClient(ctx, async (c) => {
    await c.request("navigate", [url]);
    const state = (await c.request("state")) as { url: string; title: string };
    const prev = (await loadState(ctx.session)) ?? {
      name: ctx.session, url: "", title: "", refs: [], updatedAt: 0,
    };
    await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
    return ctx.json
      ? JSON.stringify({ ok: true, url: state.url })
      : `navigated to ${state.url}`;
  });
}

export async function cmdSnapshot(
  ctx: CommandContext,
  opts: { filename?: string; depth?: string } = {},
): Promise<string> {
  return withClient(ctx, async (c) => {
    const snap = (await c.request("evaluate", [SNAPSHOT_SCRIPT])) as SnapshotResult;
    await saveState({
      name: ctx.session, url: snap.url, title: snap.title, refs: snap.refs, updatedAt: Date.now(),
    });
    const out = ctx.json ? toJson(snap) : toYaml(snap);
    if (opts.filename) {
      await Bun.write(opts.filename, out);
      return `wrote ${opts.filename}`;
    }
    // toYaml ends with a newline; trim it because the CLI layer adds one.
    return out.endsWith("\n") ? out.slice(0, -1) : out;
  });
}

export async function cmdClick(
  ctx: CommandContext,
  ref: string,
): Promise<string> {
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);

  return withClient(ctx, async (c) => {
    await c.request("click", [target.selector]);
    const state = (await c.request("state")) as { url: string; title: string };
    await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
    return ctx.json
      ? JSON.stringify({ ok: true, ref, url: state.url })
      : `clicked ${ref} (${target.role} "${target.name}")`;
  });
}

export async function cmdFill(
  ctx: CommandContext,
  ref: string,
  text: string,
): Promise<string> {
  if (text === undefined) throw new Error("usage: bowser fill <ref> <text>");
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);

  return withClient(ctx, async (c) => {
    await c.request("click", [target.selector]);
    // Clear any existing value before typing. Use JSON.stringify so selectors
    // with quotes are safe.
    const clearExpr = `(() => { const el = document.querySelector(${JSON.stringify(target.selector)}); if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`;
    await c.request("evaluate", [clearExpr]);
    await c.request("type", [text]);
    return ctx.json
      ? JSON.stringify({ ok: true, ref, text })
      : `filled ${ref} (${target.role} "${target.name}")`;
  });
}

export async function cmdType(ctx: CommandContext, text: string): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("type", [text]);
    return ctx.json ? JSON.stringify({ ok: true, text }) : `typed "${text}"`;
  });
}

export async function cmdPress(ctx: CommandContext, key: string): Promise<string> {
  if (!key) throw new Error("usage: bowser press <key>");
  return withClient(ctx, async (c) => {
    await c.request("press", [key]);
    return ctx.json ? JSON.stringify({ ok: true, key }) : `pressed ${key}`;
  });
}

export async function cmdHover(ctx: CommandContext, ref: string): Promise<string> {
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);
  return withClient(ctx, async (c) => {
    await c.request("hover", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `hovered ${ref}`;
  });
}

export async function cmdSelect(ctx: CommandContext, ref: string, value: string): Promise<string> {
  if (value === undefined) throw new Error("usage: bowser select <ref> <value>");
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);
  return withClient(ctx, async (c) => {
    await c.request("select", [target.selector, value]);
    return ctx.json ? JSON.stringify({ ok: true, ref, value }) : `selected ${ref} -> "${value}"`;
  });
}

export async function cmdCheck(ctx: CommandContext, ref: string): Promise<string> {
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);
  return withClient(ctx, async (c) => {
    await c.request("check", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `checked ${ref}`;
  });
}

export async function cmdUncheck(ctx: CommandContext, ref: string): Promise<string> {
  const prev = await loadState(ctx.session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  const target = resolveRef(prev, ref);
  return withClient(ctx, async (c) => {
    await c.request("uncheck", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `unchecked ${ref}`;
  });
}

export async function cmdScreenshot(
  ctx: CommandContext,
  opts: { ref?: string; filename?: string } = {},
): Promise<string> {
  let selector: string | undefined;
  if (opts.ref) {
    const prev = await loadState(ctx.session);
    if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
    selector = resolveRef(prev, opts.ref).selector;
  }
  return withClient(ctx, async (c) => {
    const data = (await c.request("screenshot", [selector, opts.filename])) as string | undefined;
    if (opts.filename) return ctx.json ? JSON.stringify({ ok: true, filename: opts.filename }) : `wrote ${opts.filename}`;
    return data ?? "";
  });
}

export async function cmdHistory(
  ctx: CommandContext,
  which: "back" | "forward" | "reload",
): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request(which, []);
    const state = (await c.request("state")) as { url: string; title: string };
    const prev = (await loadState(ctx.session)) ?? {
      name: ctx.session, url: "", title: "", refs: [], updatedAt: 0,
    };
    await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
    return ctx.json
      ? JSON.stringify({ ok: true, url: state.url })
      : (which === "reload" ? `reloaded ${state.url}` : `${which} -> ${state.url}`);
  });
}

export async function cmdClose(ctx: CommandContext): Promise<string> {
  const prev = await loadState(ctx.session);

  // Try to gracefully shut down the daemon. If it's not running, that's fine.
  try {
    const client = await connector(ctx)(ctx.session, { spawn: false });
    try {
      await client.request("shutdown");
    } finally {
      client.close();
    }
  } catch {
    // no daemon; that's ok
  }

  // Remove the socket file.
  try {
    await unlink(socketPath(ctx.session));
  } catch {}

  // Reset state.
  const name = prev?.name ?? ctx.session;
  await saveState({
    name,
    url: "",
    title: "",
    refs: [],
    updatedAt: Date.now(),
  });

  return ctx.json
    ? JSON.stringify({ ok: true, session: ctx.session })
    : `closed session '${ctx.session}'`;
}

export async function cmdList(ctx: CommandContext): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(homedir(), ".bowser", "sessions");
  try {
    const names = await readdir(root);
    return ctx.json ? JSON.stringify(names) : names.join("\n");
  } catch {
    return ctx.json ? "[]" : "";
  }
}

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
    return ctx.json ? JSON.stringify({ ok: true, path: existing, skipped: true }) : msg;
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

  return ctx.json
    ? JSON.stringify({ ok: true, path })
    : `installed chromium to ${path}`;
}
