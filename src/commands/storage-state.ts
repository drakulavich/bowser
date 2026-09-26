// ---------------------------------------------------------------------------
// Storage state (state-save / state-load).
//
// Dump/restore a Playwright-compatible `storageState` JSON: `cookies` plus
// per-origin localStorage. The file shape matches Playwright's storageState
// so it is interchangeable with a Playwright context. sessionStorage is
// intentionally excluded (Playwright omits it too — it is ephemeral/per-tab).
//
// bowser has no cookie access on WebKit (Bun.WebView exposes none), so save
// writes `"cookies": []` and load ignores the file's cookies, saying so on
// stderr. A persistent profile (`open --persistent`) is what keeps cookies.
//
// localStorage is captured/restored via `evaluate`, so the daemon needs an
// open page. Because the daemon holds a single page, save captures the
// current page's origin only, and load restores localStorage solely for origins
// matching the current page — other origins are reported as skipped (navigate to
// each, then load again, to restore theirs).
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import type { Command } from "../cli/registry.ts";
import { storageListScript, storageRestoreScript } from "../page-scripts.ts";
import { reply, withClient, type CommandContext } from "./context.ts";

interface StorageStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

interface StorageState {
  /** Always written empty; a loaded file's entries are counted and skipped. */
  cookies: unknown[];
  origins: StorageStateOrigin[];
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

    const storageState: StorageState = { cookies: [], origins };
    await Bun.write(target, JSON.stringify(storageState, null, 2) + "\n");
    return reply(ctx, { ok: true, file: target, origins: origins.length }, `saved ${target}`);
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
  const cookiesSkipped = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
  const origins = parsed.origins ?? [];

  return withClient(ctx, async (c) => {
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

    // A note, not an error: the localStorage above was restored. stderr, so
    // the answer on stdout (and --json) keeps its shape.
    if (cookiesSkipped > 0) {
      console.error(`${cookiesSkipped} cookies skipped (bowser has no cookie access on WebKit; use open --persistent)`);
    }
    const text =
      `loaded ${target} (${originsRestored} origin(s)` +
      (originsSkipped
        ? `, ${originsSkipped} skipped — navigate to each origin then load again to restore its localStorage`
        : "") +
      ")";
    return reply(
      ctx,
      { ok: true, file: target, cookiesSkipped, originsRestored, originsSkipped },
      text,
    );
  });
}

export const COMMANDS: Command[] = [
  {
    name: "state-save",
    summary: "Save localStorage to a Playwright storageState file",
    positional: [{ name: "file", required: true }],
    flags: [],
    run: (ctx, a) => cmdStateSave(ctx, a.positional[0] ?? ""),
  },
  {
    name: "state-load",
    summary: "Restore localStorage from a storageState file",
    positional: [{ name: "file", required: true }],
    flags: [],
    run: (ctx, a) => cmdStateLoad(ctx, a.positional[0] ?? ""),
  },
];
