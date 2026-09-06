// Evaluate commands — run a JS expression or code block in the current page.
// Both use the existing `evaluate` daemon op; no new daemon op is needed.

import type { Command } from "../cli/registry.ts";
import { runCodeScript } from "../page-scripts.ts";
import { reply, withClient, type CommandContext } from "./context.ts";

function formatEvalResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export async function cmdEval(ctx: CommandContext, expression: string): Promise<string> {
  if (!expression) throw new Error("usage: bowser eval <expression>");
  return withClient(ctx, async (c) => {
    const result = await c.request("evaluate", [expression]);
    return reply(ctx, { ok: true, result }, formatEvalResult(result));
  });
}

export async function cmdRunCode(ctx: CommandContext, code: string): Promise<string> {
  if (!code) throw new Error("usage: bowser run-code <code>");
  return withClient(ctx, async (c) => {
    const result = await c.request("evaluate", [runCodeScript(code)]);
    return reply(ctx, { ok: true, result }, formatEvalResult(result));
  });
}

export const COMMANDS: Command[] = [
  {
    name: "eval",
    summary: "Evaluate a JS expression in the page and return the result",
    positional: [{ name: "expression", required: true }],
    flags: [],
    run: (ctx, a) => cmdEval(ctx, a.positional[0] ?? ""),
  },
  {
    name: "run-code",
    summary: "Run multi-statement JS in the page and return the result",
    positional: [{ name: "code", required: true }],
    flags: [],
    run: (ctx, a) => cmdRunCode(ctx, a.positional[0] ?? ""),
  },
];
