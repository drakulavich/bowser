// Acting on the page: click, fill, type, press, hover, select, check,
// uncheck, resize. Ref-taking commands resolve their target with loadRef.

import type { Command } from "../cli/registry.ts";
import { clearForFillScript } from "../page-scripts.ts";
import { loadRef, reply, syncState, withClient, type CommandContext } from "./context.ts";

export async function cmdClick(
  ctx: CommandContext,
  ref: string,
): Promise<string> {
  const { prev, target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("click", [target.selector]);
    const state = await c.request("state");
    await syncState(prev, state);
    return reply(ctx, { ok: true, ref, url: state.url }, `clicked ${ref} (${target.role} "${target.name}")`);
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
    return reply(ctx, { ok: true, ref, text }, `filled ${ref} (${target.role} "${target.name}")`);
  });
}

export async function cmdType(ctx: CommandContext, text: string): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("type", [text]);
    return reply(ctx, { ok: true, text }, `typed "${text}"`);
  });
}

export async function cmdPress(ctx: CommandContext, key: string): Promise<string> {
  if (!key) throw new Error("usage: bowser press <key>");
  return withClient(ctx, async (c) => {
    await c.request("press", [key]);
    return reply(ctx, { ok: true, key }, `pressed ${key}`);
  });
}

export async function cmdHover(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("hover", [target.selector]);
    return reply(ctx, { ok: true, ref }, `hovered ${ref}`);
  });
}

export async function cmdSelect(ctx: CommandContext, ref: string, value: string): Promise<string> {
  if (value === undefined) throw new Error("usage: bowser select <ref> <value>");
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("select", [target.selector, value]);
    return reply(ctx, { ok: true, ref, value }, `selected ${ref} -> "${value}"`);
  });
}

export async function cmdCheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("check", [target.selector]);
    return reply(ctx, { ok: true, ref }, `checked ${ref}`);
  });
}

export async function cmdUncheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("uncheck", [target.selector]);
    return reply(ctx, { ok: true, ref }, `unchecked ${ref}`);
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
    return reply(ctx, { ok: true, width, height }, `resized ${width}x${height}`);
  });
}

export const COMMANDS: Command[] = [
  {
    name: "click",
    summary: "Click the element with the given ref",
    positional: [{ name: "ref", required: true }],
    flags: [],
    run: (ctx, a) => cmdClick(ctx, a.positional[0] ?? ""),
  },
  {
    name: "fill",
    summary: "Fill the element with the given ref with text",
    positional: [{ name: "ref", required: true }, { name: "text", required: true }],
    flags: [],
    run: (ctx, a) => cmdFill(ctx, a.positional[0] ?? "", a.positional[1] ?? ""),
  },
  {
    name: "type",
    summary: "Type text into the focused element",
    positional: [{ name: "text", required: true }],
    flags: [],
    run: (ctx, a) => cmdType(ctx, a.positional[0] ?? ""),
  },
  {
    name: "press",
    summary: "Press a key (e.g. Enter, Tab)",
    positional: [{ name: "key", required: true }],
    flags: [],
    run: (ctx, a) => cmdPress(ctx, a.positional[0] ?? ""),
  },
  {
    name: "hover",
    summary: "Hover over the element with the given ref",
    positional: [{ name: "ref", required: true }],
    flags: [],
    run: (ctx, a) => cmdHover(ctx, a.positional[0] ?? ""),
  },
  {
    name: "select",
    summary: "Select an option value in the element with the given ref",
    positional: [{ name: "ref", required: true }, { name: "value", required: true }],
    flags: [],
    run: (ctx, a) => cmdSelect(ctx, a.positional[0] ?? "", a.positional[1] ?? ""),
  },
  {
    name: "check",
    summary: "Check the checkbox/radio with the given ref",
    positional: [{ name: "ref", required: true }],
    flags: [],
    run: (ctx, a) => cmdCheck(ctx, a.positional[0] ?? ""),
  },
  {
    name: "uncheck",
    summary: "Uncheck the checkbox with the given ref",
    positional: [{ name: "ref", required: true }],
    flags: [],
    run: (ctx, a) => cmdUncheck(ctx, a.positional[0] ?? ""),
  },
  {
    name: "resize",
    summary: "Set the viewport size in pixels",
    positional: [{ name: "width", required: true }, { name: "height", required: true }],
    flags: [],
    run: (ctx, a) => cmdResize(ctx, a.positional[0] ?? "", a.positional[1] ?? ""),
  },
];
