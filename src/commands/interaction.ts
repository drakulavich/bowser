// Acting on the page: click, fill, type, press, hover, select, check,
// uncheck, resize. Ref-taking commands resolve their target with loadRef.

import { clearForFillScript } from "../page-scripts.ts";
import { loadRef, withClient, type CommandContext } from "./context.ts";
import { saveState } from "../state.ts";

export async function cmdClick(
  ctx: CommandContext,
  ref: string,
): Promise<string> {
  const { prev, target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("click", [target.selector]);
    const state = await c.request("state");
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
    await c.request("evaluate", [clearForFillScript(target.selector)]);
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

export async function cmdResize(
  ctx: CommandContext,
  widthArg: string,
  heightArg: string,
): Promise<string> {
  const width = Number(widthArg);
  const height = Number(heightArg);
  if (
    !widthArg || !heightArg ||
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0
  ) {
    throw new Error("usage: bowser resize <width> <height>");
  }
  return withClient(ctx, async (c) => {
    await c.request("resize", [width, height]);
    return ctx.json ? JSON.stringify({ ok: true, width, height }) : `resized ${width}x${height}`;
  });
}
