// Reading the page: the aria snapshot and the screenshot.

import { resolve } from "node:path";
import type { Command } from "../cli/registry.ts";
import { str } from "../cli/parser.ts";
import { SNAPSHOT_SCRIPT } from "../page-scripts.ts";
import { renderPage, renderTree, type SnapshotResult } from "../snapshot.ts";
import { saveState } from "../state.ts";
import { reply, withClient, type CommandContext } from "./context.ts";

export async function cmdSnapshot(
  ctx: CommandContext,
  opts: { filename?: string; depth?: string } = {},
): Promise<string> {
  // 0 (the default) means unlimited, as in playwright-cli.
  if (opts.depth !== undefined && !/^\d+$/.test(opts.depth)) {
    throw new Error(`usage: --depth=N requires a non-negative integer (got '${opts.depth}')`);
  }
  const depth = Number(opts.depth ?? 0);
  return withClient(ctx, async (c) => {
    const snap = (await c.request("evaluate", [SNAPSHOT_SCRIPT])) as SnapshotResult;
    await saveState({
      name: ctx.session, url: snap.url, title: snap.title, refs: snap.refs, updatedAt: Date.now(),
    });
    const out = ctx.json
      ? JSON.stringify({ snapshot: renderTree(snap.tree, depth) }, null, 2)
      : renderPage(snap, depth);
    if (opts.filename) {
      // The file holds exactly what stdout would: the text plus the CLI's newline.
      await Bun.write(opts.filename, out + "\n");
      return `wrote ${opts.filename}`;
    }
    return out;
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
    return reply(ctx, { ok: true, filename }, `wrote ${filename}`);
  });
}

export const COMMANDS: Command[] = [
  {
    name: "snapshot",
    summary: "Capture an aria-tree YAML snapshot of the page (refs for interaction)",
    positional: [],
    flags: [{ name: "filename", kind: "string" }, { name: "depth", kind: "string" }],
    run: (ctx, a) => cmdSnapshot(ctx, {
      filename: str(a.flags, "filename"),
      depth: str(a.flags, "depth"),
    }),
  },
  {
    name: "screenshot",
    summary: "Save a full-page PNG screenshot",
    positional: [],
    flags: [{ name: "filename", kind: "string" }],
    run: (ctx, a) => cmdScreenshot(ctx, { filename: str(a.flags, "filename") }),
  },
];
