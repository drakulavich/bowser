// Evaluate commands — run a JS expression or code block in the current page.
// Both use the existing `evaluate` daemon op; no new daemon op is needed.

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
