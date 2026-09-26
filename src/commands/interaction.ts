// Acting on the page: click, fill, type, press, hover, select, check,
// uncheck, resize. Ref-taking commands find their target with loadRef, check
// its kind, then act on the liveSelector the page returns for it.

import type { Command } from "../cli/registry.ts";
import { clearForFillScript } from "../page-scripts.ts";
import type { Ref } from "../state.ts";
import { liveSelector, loadRef, readStdin, reply, syncState, withClient, type CommandContext } from "./context.ts";

// Snapshots give refs to non-interactive nodes too (listitems, paragraphs), so
// check/uncheck/select/fill refuse a ref that cannot take the action, from the
// saved ref alone: no daemon request, no side effect. Spec §5.
const CHECKABLE = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];
const FILLABLE = ["textbox", "searchbox", "spinbutton", "combobox"];
const KINDS = {
  check: { what: "a checkbox or radio button", ok: (r: Ref) => CHECKABLE.includes(r.role) },
  select: { what: "a <select> element", ok: (r: Ref) => r.tag === "select" },
  fill: {
    what: "an <input>, <textarea> or contenteditable element",
    ok: (r: Ref) => r.editable === true || (["input", "textarea"].includes(r.tag) && FILLABLE.includes(r.role)),
  },
};

function requireKind(kind: keyof typeof KINDS, ref: string, target: Ref): void {
  const k = KINDS[kind];
  if (!k.ok(target)) throw new Error(`ref '${ref}' is not ${k.what} (${target.role})`);
}

export async function cmdClick(
  ctx: CommandContext,
  ref: string,
): Promise<string> {
  const { prev, target } = await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("click", [await liveSelector(c, ref)]);
    const state = await c.request("state");
    await syncState(prev, state);
    return reply(ctx, { ok: true, ref, url: state.url }, `clicked ${ref} (${target.role} "${target.name}")`);
  });
}

const FILL_USAGE = "usage: bowser fill <ref> <text> or bowser fill <ref> --stdin";

/** `op read` and `echo` end their output with one line ending; nothing else
 *  in piped text is ours to change. */
function withoutFinalNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

/** With `stdin`, the text comes from standard input so a secret never
 *  reaches argv, and it is never echoed back. */
export async function cmdFill(
  ctx: CommandContext,
  ref: string,
  text: string | undefined,
  opts: { stdin?: boolean } = {},
): Promise<string> {
  if (opts.stdin && text !== undefined) throw new Error(`${FILL_USAGE} (not both)`);
  if (!opts.stdin && text === undefined) throw new Error(FILL_USAGE);
  const value = opts.stdin ? withoutFinalNewline(await (ctx.readStdin ?? readStdin)()) : text!;
  const { target } = await loadRef(ctx.session, ref);
  requireKind("fill", ref, target);
  return withClient(ctx, async (c) => {
    const selector = await liveSelector(c, ref);
    await c.request("click", [selector]);
    await c.request("evaluate", [clearForFillScript(selector)]);
    await c.request("type", [value]);
    const json = opts.stdin ? { ok: true, ref } : { ok: true, ref, text };
    return reply(ctx, json, `filled ${ref} (${target.role} "${target.name}")`);
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
  await loadRef(ctx.session, ref);
  return withClient(ctx, async (c) => {
    await c.request("hover", [await liveSelector(c, ref)]);
    return reply(ctx, { ok: true, ref }, `hovered ${ref}`);
  });
}

export async function cmdSelect(ctx: CommandContext, ref: string, value: string): Promise<string> {
  if (value === undefined) throw new Error("usage: bowser select <ref> <value>");
  const { target } = await loadRef(ctx.session, ref);
  requireKind("select", ref, target);
  return withClient(ctx, async (c) => {
    await c.request("select", [await liveSelector(c, ref), value]);
    return reply(ctx, { ok: true, ref, value }, `selected ${ref} -> "${value}"`);
  });
}

export async function cmdCheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  requireKind("check", ref, target);
  return withClient(ctx, async (c) => {
    await c.request("check", [await liveSelector(c, ref)]);
    return reply(ctx, { ok: true, ref }, `checked ${ref}`);
  });
}

export async function cmdUncheck(ctx: CommandContext, ref: string): Promise<string> {
  const { target } = await loadRef(ctx.session, ref);
  requireKind("check", ref, target);
  return withClient(ctx, async (c) => {
    await c.request("uncheck", [await liveSelector(c, ref)]);
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
    summary: "Fill the element with the given ref with text, or with piped stdin under --stdin",
    positional: [{ name: "ref", required: true }, { name: "text", required: false }],
    // Not over MCP: the text is already a JSON string there, and the server's
    // own stdin is the JSON-RPC stream.
    flags: [{ name: "stdin", kind: "boolean", mcp: false }],
    run: (ctx, a) => cmdFill(ctx, a.positional[0] ?? "", a.positional[1], { stdin: a.flags.stdin === true }),
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
