// ---------------------------------------------------------------------------
// Cookie commands — require the chrome backend (Bun.WebView.cdp() is chrome-only)
// ---------------------------------------------------------------------------

import type { CookieParam, DeleteCookieOptions } from "../cdp/types.ts";
import type { Command } from "../cli/registry.ts";
import type { DaemonConnection } from "../daemon/protocol.ts";
import { reply, withClient, type CommandContext } from "./context.ts";

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
  c: DaemonConnection,
  opts: { domain?: string; url?: string },
): Promise<string[]> {
  if (opts.url) return [opts.url];
  if (opts.domain) {
    // Build a minimal URL from the domain so CDP can scope the cookie query.
    const scheme = "https";
    return [`${scheme}://${opts.domain}/`];
  }
  // Default to the current page URL from the daemon's state op.
  const state = await c.request("state");
  const url = state.url;
  return url ? [url] : [];
}

export async function cmdCookieList(
  ctx: CommandContext,
  opts: CookieListOptions = {},
): Promise<string> {
  return withClient(ctx, async (c) => {
    const urls = await cookieUrls(c, opts);
    const cookies = await c.request("cookie-get-all", [urls.length ? urls : undefined]);
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
    const cookies = await c.request("cookie-get-all", [urls.length ? urls : undefined]);
    const found = cookies.find((ck) => ck.name === name);
    return reply(
      ctx,
      found ? { ok: true, cookie: found } : { ok: false },
      found ? found.value : "",
    );
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
        await c.request("state")
      ).url;
      if (targetUrl) param.url = targetUrl;
    }
    if (opts.path) param.path = opts.path;
    if (opts.httpOnly !== undefined) param.httpOnly = opts.httpOnly;
    if (opts.secure !== undefined) param.secure = opts.secure;
    if (opts.sameSite) param.sameSite = opts.sameSite;
    if (opts.expires !== undefined) param.expires = opts.expires;
    await c.request("cookie-set", [param]);
    return reply(ctx, { ok: true }, `set ${name}`);
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
    return reply(ctx, { ok: true }, `deleted ${name}`);
  });
}

export async function cmdCookieClear(ctx: CommandContext): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("cookie-clear", []);
    return reply(ctx, { ok: true }, "cleared");
  });
}

export const COMMANDS: Command[] = [
  {
    name: "cookie-list",
    summary: "List cookies, HttpOnly included (chrome backend only)",
    positional: [],
    flags: [
      { name: "domain", kind: "string" },
      { name: "url",    kind: "string" },
    ],
    run: (ctx, a) => cmdCookieList(ctx, {
      domain: a.flags.domain as string | undefined,
      url:    a.flags.url    as string | undefined,
    }),
  },
  {
    name: "cookie-get",
    summary: "Print a cookie's value (chrome backend only)",
    positional: [{ name: "name", required: true }],
    flags: [
      { name: "domain", kind: "string" },
      { name: "url",    kind: "string" },
    ],
    run: (ctx, a) => cmdCookieGet(ctx, a.positional[0] ?? "", {
      domain: a.flags.domain as string | undefined,
      url:    a.flags.url    as string | undefined,
    }),
  },
  {
    name: "cookie-set",
    summary: "Set a cookie (chrome backend only)",
    positional: [{ name: "name", required: true }, { name: "value", required: true }],
    flags: [
      { name: "domain",    kind: "string" },
      { name: "url",       kind: "string" },
      { name: "path",      kind: "string" },
      { name: "http-only", kind: "boolean" },
      { name: "secure",    kind: "boolean" },
      { name: "same-site", kind: "string", placeholder: "Lax|Strict|None" },
      { name: "expires",   kind: "string", placeholder: "<unix-seconds>" },
    ],
    run: (ctx, a) => cmdCookieSet(ctx, a.positional[0] ?? "", a.positional[1] ?? "", {
      domain:   a.flags.domain    as string | undefined,
      url:      a.flags.url       as string | undefined,
      path:     a.flags.path      as string | undefined,
      httpOnly: a.flags["http-only"] ? true : undefined,
      secure:   a.flags.secure       ? true : undefined,
      sameSite: a.flags["same-site"] as "Strict" | "Lax" | "None" | undefined,
      expires:  a.flags.expires !== undefined ? Number(a.flags.expires) : undefined,
    }),
  },
  {
    name: "cookie-delete",
    summary: "Delete matching cookie(s) (chrome backend only)",
    positional: [{ name: "name", required: true }],
    flags: [
      { name: "domain", kind: "string" },
      { name: "url",    kind: "string" },
      { name: "path",   kind: "string" },
    ],
    run: (ctx, a) => cmdCookieDelete(ctx, a.positional[0] ?? "", {
      domain: a.flags.domain as string | undefined,
      url:    a.flags.url    as string | undefined,
      path:   a.flags.path   as string | undefined,
    }),
  },
  {
    name: "cookie-clear",
    summary: "Wipe all cookies in this session (chrome backend only)",
    positional: [], flags: [],
    run: (ctx) => cmdCookieClear(ctx),
  },
];
