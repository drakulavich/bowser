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
  sessionsRoot,
  type SessionState,
} from "./state.ts";
import type { Cookie, CookieParam, DeleteCookieOptions } from "./cdp/types.ts";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CommandContext {
  session: string;
  json: boolean;
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

function emptyState(name: string): SessionState {
  return { name, url: "", title: "", refs: [], updatedAt: 0 };
}

/** Fail loud when a real navigation still reports about:blank. The daemon's
 *  state op resolves the URL via realUrl() (which falls back to location.href),
 *  so reaching here with about:blank means BOTH the url getter and location.href
 *  agree the page never committed — a genuine load failure, not the chrome
 *  getter quirk (which realUrl already corrects). */
function assertNavigated(requested: string, finalUrl: string): void {
  if (requested && requested !== "about:blank" && finalUrl === "about:blank") {
    throw new Error(`navigate: page did not load ${requested} (ended on about:blank)`);
  }
}

async function loadRef(session: string, ref: string) {
  const prev = await loadState(session);
  if (!prev) throw new Error("no open page. Run 'bowser open <url>' first.");
  return { prev, target: resolveRef(prev, ref) };
}

export async function cmdOpen(ctx: CommandContext, url?: string): Promise<string> {
  await ensureSessionDir(ctx.session);
  return withClient(ctx, async (c) => {
    if (url) await c.request("navigate", [url]);
    const state = (await c.request("state")) as { url: string; title: string };
    if (url) assertNavigated(url, state.url);
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
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withClient(ctx, async (c) => {
    await c.request("navigate", [url]);
    const state = (await c.request("state")) as { url: string; title: string };
    assertNavigated(url, state.url);
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
  let depth: number | undefined;
  if (opts.depth !== undefined) {
    const n = Number(opts.depth);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`usage: --depth=N requires a positive integer (got '${opts.depth}')`);
    }
    depth = n;
  }
  return withClient(ctx, async (c) => {
    const snap = (await c.request("evaluate", [SNAPSHOT_SCRIPT])) as SnapshotResult;
    await saveState({
      name: ctx.session, url: snap.url, title: snap.title, refs: snap.refs, updatedAt: Date.now(),
    });
    const out = ctx.json ? toJson(snap) : toYaml(snap, depth);
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
  const { prev, target } = await loadRef(ctx.session, ref);
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
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("click", [target.selector]);
    // JSON.stringify so selectors with quotes are safely embedded.
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
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("hover", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `hovered ${ref}`;
  });
}

export async function cmdSelect(ctx: CommandContext, ref: string, value: string): Promise<string> {
  if (value === undefined) throw new Error("usage: bowser select <ref> <value>");
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("select", [target.selector, value]);
    return ctx.json ? JSON.stringify({ ok: true, ref, value }) : `selected ${ref} -> "${value}"`;
  });
}

export async function cmdCheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("check", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `checked ${ref}`;
  });
}

export async function cmdUncheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("uncheck", [target.selector]);
    return ctx.json ? JSON.stringify({ ok: true, ref }) : `unchecked ${ref}`;
  });
}

/** Find a non-colliding path: returns `base` if free, else base-1, base-2, …
 *  (suffix inserted before the extension). `exists` is injected for testing.
 *  Best-effort: there is a small check-then-write window, acceptable for a
 *  single-user CLI. */
export async function nextAvailablePath(
  base: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(base))) return base;
  const slash = base.lastIndexOf("/");
  const dot = base.lastIndexOf(".");
  // Only treat as an extension when the dot is inside the basename and not its
  // first char (so "shot.png" -> "shot"+".png", but "/tmp/.foo" stays whole).
  const hasExt = dot > slash + 1;
  const stem = hasExt ? base.slice(0, dot) : base;
  const ext = hasExt ? base.slice(dot) : "";
  for (let i = 1; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!(await exists(cand))) return cand;
  }
}

export async function cmdScreenshot(
  ctx: CommandContext,
  opts: { filename?: string } = {},
): Promise<string> {
  // Full-page only. The default name auto-increments so repeated screenshots
  // don't clobber each other; an explicit --filename writes exactly there.
  const filename =
    opts.filename ??
    (await nextAvailablePath(`screenshot-${ctx.session}.png`, (p) => Bun.file(p).exists()));
  // Resolve against the CLI's cwd and let the daemon write the file. The daemon
  // runs with a different cwd, and its PNG payload (~140 KB base64) must not be
  // shipped back over the socket — so we hand it an absolute target path.
  const abs = resolve(process.cwd(), filename);
  return withClient(ctx, async (c) => {
    await c.request("screenshot", [abs]);
    return ctx.json ? JSON.stringify({ ok: true, filename }) : `wrote ${filename}`;
  });
}

export async function cmdHistory(
  ctx: CommandContext,
  which: "back" | "forward" | "reload",
): Promise<string> {
  const prev = (await loadState(ctx.session)) ?? emptyState(ctx.session);
  return withClient(ctx, async (c) => {
    await c.request(which, []);
    const state = (await c.request("state")) as { url: string; title: string };
    await saveState({ ...prev, url: state.url, title: state.title, updatedAt: Date.now() });
    return ctx.json
      ? JSON.stringify({ ok: true, url: state.url })
      : (which === "reload" ? `reloaded ${state.url}` : `${which} -> ${state.url}`);
  });
}

export async function cmdClose(
  ctx: CommandContext,
  opts: { name?: string; all?: boolean } = {},
): Promise<string> {
  if (opts.all) return closeAll(ctx);
  return closeOne(ctx, opts.name ?? ctx.session);
}

async function closeOne(ctx: CommandContext, session: string): Promise<string> {
  const prev = await loadState(session);

  // Try to gracefully shut down the daemon. If it's not running, that's fine.
  try {
    const client = await connector(ctx)(session, { spawn: false });
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
    await unlink(socketPath(session));
  } catch {}

  await saveState({ ...emptyState(prev?.name ?? session), updatedAt: Date.now() });

  return ctx.json
    ? JSON.stringify({ ok: true, session })
    : `closed session '${session}'`;
}

async function closeAll(ctx: CommandContext): Promise<string> {
  let names: string[] = [];
  try {
    const entries = await readdir(sessionsRoot(), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no sessions root; nothing to close
  }
  const closed: string[] = [];
  const failed: string[] = [];
  for (const name of names) {
    try {
      await closeOne(ctx, name);
      closed.push(name);
    } catch {
      failed.push(name); // best-effort: keep closing the rest
    }
  }
  if (ctx.json) return JSON.stringify({ ok: failed.length === 0, closed, failed });
  if (closed.length === 0 && failed.length === 0) return "no sessions to close";
  const parts: string[] = [];
  if (closed.length > 0) {
    const word = closed.length === 1 ? "session" : "sessions";
    parts.push(`closed ${closed.length} ${word}: ${closed.join(", ")}`);
  }
  if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
  return parts.join("; ");
}

// Web Storage commands (localStorage and sessionStorage). Implemented via
// `evaluate` against the live page, so they require an open page in the
// session. Values are always strings — that's the Storage API surface, no
// JSON encoding is implied.

// Wraps a body in a try/catch so a SecurityError (e.g. on `about:blank` or
// pages where storage is disabled) surfaces as a readable daemon error rather
// than a bare DOMException.
function storageScript(area: "localStorage" | "sessionStorage", body: string): string {
  return `(() => { try { ${body} } catch (e) { throw new Error('${area}: ' + (e && e.message || e)); } })()`;
}

async function storageList(ctx: CommandContext, area: "localStorage" | "sessionStorage"): Promise<string> {
  return withClient(ctx, async (c) => {
    const entries = (await c.request("evaluate", [
      storageScript(area, `const o = {}; for (let i = 0; i < ${area}.length; i++) { const k = ${area}.key(i); o[k] = ${area}.getItem(k); } return o;`),
    ])) as Record<string, string> | null;
    const obj = entries ?? {};
    if (ctx.json) return JSON.stringify(obj);
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    return keys.map((k) => `${k}=${obj[k]}`).join("\n");
  });
}

async function storageGet(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key>`);
  return withClient(ctx, async (c) => {
    const val = (await c.request("evaluate", [
      storageScript(area, `return ${area}.getItem(${JSON.stringify(key)});`),
    ])) as string | null;
    if (ctx.json) return JSON.stringify({ ok: true, key, value: val });
    return val ?? "";
  });
}

async function storageSet(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
  value: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key> <value>`);
  if (value === undefined) throw new Error(`usage: bowser ${command} <key> <value>`);
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [
      storageScript(area, `${area}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`),
    ]);
    return ctx.json ? JSON.stringify({ ok: true, key, value }) : `set ${key}`;
  });
}

async function storageDelete(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key>`);
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [
      storageScript(area, `${area}.removeItem(${JSON.stringify(key)});`),
    ]);
    return ctx.json ? JSON.stringify({ ok: true, key }) : `deleted ${key}`;
  });
}

async function storageClear(ctx: CommandContext, area: "localStorage" | "sessionStorage"): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [storageScript(area, `${area}.clear();`)]);
    return ctx.json ? JSON.stringify({ ok: true }) : "cleared";
  });
}

// Evaluate commands — run a JS expression or code block in the current page.
// Both use the existing `evaluate` daemon op; no new daemon op is needed.

function formatEvalResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export async function cmdEval(ctx: CommandContext, expression: string): Promise<string> {
  if (!expression) throw new Error("usage: bowser eval <expression>");
  return withClient(ctx, async (c) => {
    const result = await c.request("evaluate", [expression]);
    if (ctx.json) return JSON.stringify({ ok: true, result });
    return formatEvalResult(result);
  });
}

export async function cmdRunCode(ctx: CommandContext, code: string): Promise<string> {
  if (!code) throw new Error("usage: bowser run-code <code>");
  const wrapped = `(() => { ${code} })()`;
  return withClient(ctx, async (c) => {
    const result = await c.request("evaluate", [wrapped]);
    if (ctx.json) return JSON.stringify({ ok: true, result });
    return formatEvalResult(result);
  });
}

export const cmdLocalStorageList = (ctx: CommandContext) => storageList(ctx, "localStorage");
export const cmdLocalStorageGet = (ctx: CommandContext, key: string) =>
  storageGet(ctx, "localStorage", "localstorage-get", key);
export const cmdLocalStorageSet = (ctx: CommandContext, key: string, value: string) =>
  storageSet(ctx, "localStorage", "localstorage-set", key, value);
export const cmdLocalStorageDelete = (ctx: CommandContext, key: string) =>
  storageDelete(ctx, "localStorage", "localstorage-delete", key);
export const cmdLocalStorageClear = (ctx: CommandContext) => storageClear(ctx, "localStorage");

export const cmdSessionStorageList = (ctx: CommandContext) => storageList(ctx, "sessionStorage");
export const cmdSessionStorageGet = (ctx: CommandContext, key: string) =>
  storageGet(ctx, "sessionStorage", "sessionstorage-get", key);
export const cmdSessionStorageSet = (ctx: CommandContext, key: string, value: string) =>
  storageSet(ctx, "sessionStorage", "sessionstorage-set", key, value);
export const cmdSessionStorageDelete = (ctx: CommandContext, key: string) =>
  storageDelete(ctx, "sessionStorage", "sessionstorage-delete", key);
export const cmdSessionStorageClear = (ctx: CommandContext) => storageClear(ctx, "sessionStorage");

export async function cmdList(ctx: CommandContext): Promise<string> {
  try {
    const entries = await readdir(sessionsRoot(), { withFileTypes: true });
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
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

// ---------------------------------------------------------------------------
// Cookie commands — require the chrome backend (Bun.WebView.cdp() is chrome-only)
// ---------------------------------------------------------------------------

export interface CookieListOptions {
  domain?: string;
  url?: string;
}

export interface CookieSetOptions {
  domain?: string;
  url?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

export interface CookieDeleteOptions {
  domain?: string;
  url?: string;
  path?: string;
}

/** Resolve the URL scope for cookie-list / cookie-get:
 *  explicit --url > --domain translated to http(s) URL > current page URL from daemon. */
async function cookieUrls(
  c: DaemonClient,
  opts: { domain?: string; url?: string },
): Promise<string[]> {
  if (opts.url) return [opts.url];
  if (opts.domain) {
    // Build a minimal URL from the domain so CDP can scope the cookie query.
    const scheme = "https";
    return [`${scheme}://${opts.domain}/`];
  }
  // Default to the current page URL from the daemon's state op.
  const state = (await c.request("state")) as { url: string; title: string };
  const url = state.url;
  return url ? [url] : [];
}

export async function cmdCookieList(
  ctx: CommandContext,
  opts: CookieListOptions = {},
): Promise<string> {
  return withClient(ctx, async (c) => {
    const urls = await cookieUrls(c, opts);
    const cookies = (await c.request("cookie-get-all", [urls.length ? urls : undefined])) as Cookie[];
    if (ctx.json) return JSON.stringify(cookies);
    if (cookies.length === 0) return "";
    return cookies.map((ck) => `${ck.name}=${ck.value}`).join("\n");
  });
}

export async function cmdCookieGet(
  ctx: CommandContext,
  name: string,
  opts: CookieListOptions = {},
): Promise<string> {
  if (!name) throw new Error("usage: bowser cookie-get <name> [--domain=<d>] [--url=<u>]");
  return withClient(ctx, async (c) => {
    const urls = await cookieUrls(c, opts);
    const cookies = (await c.request("cookie-get-all", [urls.length ? urls : undefined])) as Cookie[];
    const found = cookies.find((ck) => ck.name === name);
    if (ctx.json) {
      return found
        ? JSON.stringify({ ok: true, cookie: found })
        : JSON.stringify({ ok: false });
    }
    return found ? found.value : "";
  });
}

export async function cmdCookieSet(
  ctx: CommandContext,
  name: string,
  value: string,
  opts: CookieSetOptions = {},
): Promise<string> {
  if (!name) throw new Error("usage: bowser cookie-set <name> <value> [--domain=<d>] [--url=<u>]");
  if (value === undefined) throw new Error("usage: bowser cookie-set <name> <value> [--domain=<d>] [--url=<u>]");
  return withClient(ctx, async (c) => {
    const param: CookieParam = { name, value };
    if (opts.domain) {
      param.domain = opts.domain;
    } else {
      // Default url to the current page if no explicit url/domain given.
      const targetUrl = opts.url ?? (
        (await c.request("state")) as { url: string; title: string }
      ).url;
      if (targetUrl) param.url = targetUrl;
    }
    if (opts.path) param.path = opts.path;
    if (opts.httpOnly !== undefined) param.httpOnly = opts.httpOnly;
    if (opts.secure !== undefined) param.secure = opts.secure;
    if (opts.sameSite) param.sameSite = opts.sameSite;
    if (opts.expires !== undefined) param.expires = opts.expires;
    await c.request("cookie-set", [param]);
    return ctx.json ? JSON.stringify({ ok: true }) : `set ${name}`;
  });
}

export async function cmdCookieDelete(
  ctx: CommandContext,
  name: string,
  opts: CookieDeleteOptions = {},
): Promise<string> {
  if (!name) throw new Error("usage: bowser cookie-delete <name> [--domain=<d>] [--url=<u>] [--path=<p>]");
  return withClient(ctx, async (c) => {
    const deleteOpts: DeleteCookieOptions = {};
    if (opts.url) deleteOpts.url = opts.url;
    if (opts.domain) deleteOpts.domain = opts.domain;
    if (opts.path) deleteOpts.path = opts.path;
    await c.request("cookie-delete", [name, deleteOpts]);
    return ctx.json ? JSON.stringify({ ok: true }) : `deleted ${name}`;
  });
}

export async function cmdCookieClear(ctx: CommandContext): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("cookie-clear", []);
    return ctx.json ? JSON.stringify({ ok: true }) : "cleared";
  });
}
