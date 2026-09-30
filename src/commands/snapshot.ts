// Reading the page: the aria snapshot and the screenshot.

import { resolve } from "node:path";
import { str } from "../cli/parser.ts";
import { READ_VIEWPORT, SNAPSHOT_SCRIPT } from "../page-scripts.ts";
import type { DaemonConnection } from "../daemon/protocol.ts";
import { renderPage, renderTree, type SnapshotResult } from "../snapshot.ts";
import { loadState, saveState } from "../state.ts";
import { dialogsJson, modalState, reply, withClient, withPageClient, type CommandContext, type Command } from "./context.ts";
import { UserError } from "../errors.ts";

export async function cmdSnapshot(
  ctx: CommandContext,
  opts: { filename?: string; depth?: string } = {},
): Promise<string> {
  // 0 (the default) means unlimited, as in playwright-cli.
  if (opts.depth !== undefined && !/^\d+$/.test(opts.depth)) {
    throw new UserError(`usage: --depth=N requires a non-negative integer (got '${opts.depth}')`);
  }
  const depth = Number(opts.depth ?? 0);
  return withPageClient(ctx, async (c) => {
    const snap = (await c.request("evaluate", [SNAPSHOT_SCRIPT])) as SnapshotResult;
    await saveState({
      ...(await loadState(ctx.session)),
      name: ctx.session, url: snap.url, title: snap.title, refs: snap.refs, updatedAt: Date.now(),
    });
    // Dialogs the daemon answered since the last command that printed them
    // (a page timer's, say). Nothing is blocked, so the tree renders too.
    const dialogs = dialogsJson(c);
    const withDialogs = dialogs.length ? { dialogs } : {};
    if (opts.filename) {
      // The file always holds the text form, with its Modal state lines, plus
      // the CLI's newline; --json changes only the reply, which has
      // screenshot's shape (F38). Reported by its absolute path: a caller
      // that does not know this process's cwd (an MCP client) could not find
      // it otherwise.
      const abs = resolve(opts.filename);
      await Bun.write(abs, renderPage(snap, depth, modalState(c)) + "\n");
      return reply(ctx, { ok: true, filename: abs, ...withDialogs }, `wrote ${abs}`);
    }
    return ctx.json
      ? JSON.stringify({ snapshot: renderTree(snap.tree, depth), ...withDialogs }, null, 2)
      : renderPage(snap, depth, modalState(c));
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

/** The tallest viewport, in CSS pixels, that WebKit still captures at this
 *  width. WebKit refuses a capture whose pixel buffer reaches 4 GiB (2^30
 *  pixels at 4 bytes each), with rows padded to 32 pixels, and says only
 *  "An unknown error occurred" (#69). Measured on Bun 1.4.2 at pixel ratio
 *  2, one fresh view per probe: at height 16384 the widest capture is 16368
 *  and 16369 fails; at width 16384 the tallest is 16383. No Bun.WebView
 *  option lowers the scale, so a larger viewport cannot be captured. */
export function maxCaptureHeight(width: number, dpr: number): number {
  // An invalid scale factor predicts nothing: no limit, so the capture keeps
  // its own error (a negative one would also never end the loop below).
  if (!Number.isFinite(dpr) || dpr <= 0) return Number.POSITIVE_INFINITY;
  // WebKit rounds CSS dimensions to device pixels before padding each row.
  const rowPixels = Math.ceil(Math.round(width * dpr) / 32) * 32;
  const maxPixelHeight = Math.floor((2 ** 30 - 1) / rowPixels);
  let height = Math.floor(maxPixelHeight / dpr);
  // Keep the suggested CSS height aligned with the same nearest-pixel
  // rounding: floor(maxPixelHeight / dpr) can reject one capturable pixel.
  while (Math.round((height + 1) * dpr) <= maxPixelHeight) height++;
  while (Math.round(height * dpr) > maxPixelHeight) height--;
  return height;
}

/** The error to show instead of a failed capture's, when the viewport is
 *  past WebKit's capture limit; undefined when it is not, or when the page
 *  does not answer. */
async function tooLargeToCapture(c: DaemonConnection): Promise<UserError | undefined> {
  try {
    const [width, height, dpr] = (await c.request("evaluate", [READ_VIEWPORT])) as [number, number, number];
    const maxHeight = maxCaptureHeight(width, dpr);
    if (height <= maxHeight) return undefined;
    return new UserError(
      `screenshot: WebKit cannot capture a ${width}x${height} viewport at pixel ratio ${dpr} (its pixels would fill 4 GiB); ` +
      `run 'bowser resize ${width} ${maxHeight}' or smaller`,
    );
  } catch {
    return undefined;
  }
}

export async function cmdScreenshot(
  ctx: CommandContext,
  opts: { filename?: string } = {},
): Promise<string> {
  // The viewport only, as playwright-cli without --full-page. The default name auto-increments so repeated screenshots
  // don't clobber each other; an explicit --filename writes exactly there.
  const filename =
    opts.filename ??
    (await nextAvailablePath(`screenshot-${ctx.session}.png`, (p) => Bun.file(p).exists()));
  // Resolve against the CLI's cwd and let the daemon write the file. The daemon
  // runs with a different cwd, and its PNG payload (~140 KB base64) must not be
  // shipped back over the socket — so we hand it an absolute target path.
  const abs = resolve(process.cwd(), filename);
  return withClient(ctx, async (c) => {
    try {
      await c.request("screenshot", [abs]);
    } catch (err) {
      throw (await tooLargeToCapture(c)) ?? err;
    }
    // The absolute path, for the same reason as snapshot --filename.
    return reply(ctx, { ok: true, filename: abs }, `wrote ${abs}`);
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
    summary: "Save a PNG screenshot of the viewport",
    positional: [],
    flags: [{ name: "filename", kind: "string" }],
    run: (ctx, a) => cmdScreenshot(ctx, { filename: str(a.flags, "filename") }),
  },
];
