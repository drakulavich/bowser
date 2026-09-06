// ---------------------------------------------------------------------------
// Storage state (state-save / state-load).
//
// Dump/restore a Playwright-compatible `storageState` JSON: the full cookie jar
// plus per-origin localStorage. The file shape matches Playwright's storageState
// so it is interchangeable with a Playwright context. sessionStorage is
// intentionally excluded (Playwright omits it too — it is ephemeral/per-tab).
//
// Cookies require the chrome backend (cookie-get-all surfaces a friendly error
// on webkit). localStorage is captured/restored via `evaluate`, so the daemon
// needs an open page. Because the daemon holds a single page, save captures the
// current page's origin only, and load restores localStorage solely for origins
// matching the current page — other origins are reported as skipped (navigate to
// each, then load again, to restore theirs).
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import type { Cookie, CookieParam } from "../cdp/types.ts";
import { storageListScript, storageRestoreScript } from "../page-scripts.ts";
import { withClient, type CommandContext } from "./context.ts";

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Expiry as Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/** CDP exposes sameSite values ("Unspecified"/"Extended") that Playwright's
 *  storageState does not. Collapse anything that isn't Strict/None to Lax,
 *  matching Playwright's default. */
function normalizeSameSite(s: Cookie["sameSite"]): "Strict" | "Lax" | "None" {
  return s === "Strict" || s === "None" ? s : "Lax";
}

function pageOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function cmdStateSave(ctx: CommandContext, file: string): Promise<string> {
  if (!file) throw new Error("usage: bowser state-save <file>");
  const target = resolve(file);
  return withClient(ctx, async (c) => {
    // Whole cookie jar (no url scope). chrome backend only.
    const cookies = await c.request("cookie-get-all", [undefined]);
    const stateCookies: StorageStateCookie[] = cookies.map((ck) => ({
      name: ck.name,
      value: ck.value,
      domain: ck.domain,
      path: ck.path,
      expires: ck.expires,
      httpOnly: ck.httpOnly,
      secure: ck.secure,
      sameSite: normalizeSameSite(ck.sameSite),
    }));

    const state = await c.request("state");
    const origin = pageOrigin(state.url);
    const entries = (await c.request("evaluate", [
      storageListScript("localStorage"),
    ])) as Record<string, string> | null;
    const local = entries ?? {};
    const origins: StorageStateOrigin[] = [];
    if (origin && Object.keys(local).length > 0) {
      origins.push({
        origin,
        localStorage: Object.keys(local).map((k) => ({ name: k, value: local[k]! })),
      });
    }

    const storageState: StorageState = { cookies: stateCookies, origins };
    await Bun.write(target, JSON.stringify(storageState, null, 2) + "\n");
    return ctx.json
      ? JSON.stringify({ ok: true, file: target, cookies: stateCookies.length, origins: origins.length })
      : `saved ${target}`;
  });
}

export async function cmdStateLoad(ctx: CommandContext, file: string): Promise<string> {
  if (!file) throw new Error("usage: bowser state-load <file>");
  const target = resolve(file);
  const f = Bun.file(target);
  if (!(await f.exists())) throw new Error(`state-load: file not found: ${target}`);
  let parsed: StorageState;
  try {
    parsed = (await f.json()) as StorageState;
  } catch {
    throw new Error(`state-load: invalid JSON in ${target}`);
  }
  const cookies = parsed.cookies ?? [];
  const origins = parsed.origins ?? [];

  return withClient(ctx, async (c) => {
    for (const ck of cookies) {
      const param: CookieParam = {
        name: ck.name,
        value: ck.value,
        domain: ck.domain,
        path: ck.path,
        httpOnly: ck.httpOnly,
        secure: ck.secure,
        sameSite: ck.sameSite,
      };
      // Omit expiry for session cookies (-1) so they restore as session cookies.
      if (ck.expires !== undefined && ck.expires >= 0) param.expires = ck.expires;
      await c.request("cookie-set", [param]);
    }

    const state = await c.request("state");
    const current = pageOrigin(state.url);
    let originsRestored = 0;
    let originsSkipped = 0;
    for (const o of origins) {
      if (current && o.origin === current) {
        if (o.localStorage.length > 0) {
          await c.request("evaluate", [storageRestoreScript("localStorage", o.localStorage)]);
        }
        originsRestored++;
      } else {
        originsSkipped++;
      }
    }

    return ctx.json
      ? JSON.stringify({ ok: true, file: target, cookies: cookies.length, originsRestored, originsSkipped })
      : `loaded ${target} (${cookies.length} cookie(s), ${originsRestored} origin(s)` +
        (originsSkipped
          ? `, ${originsSkipped} skipped — navigate to each origin then load again to restore its localStorage`
          : "") +
        ")";
  });
}
