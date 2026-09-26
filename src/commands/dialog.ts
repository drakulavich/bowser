// dialog-accept [text] and dialog-dismiss: the answer the daemon gives the
// next dialog on the current page, once. Every dialog is answered the moment
// it opens, so the answer is set before the action, not after it (unlike
// playwright-cli).

import type { Command } from "../cli/registry.ts";
import { replyPage, withPageClient, type CommandContext } from "./context.ts";

export async function cmdDialog(ctx: CommandContext, accept: boolean, text?: string): Promise<string> {
  return withPageClient(ctx, async (c) => {
    await c.request("dialog-answer", text === undefined ? [accept] : [accept, text]);
    const verb = accept ? "accepted" : "dismissed";
    return replyPage(ctx, c, { ok: true, next: verb }, `next dialog will be ${verb}`);
  });
}

export const COMMANDS: Command[] = [
  {
    name: "dialog-accept",
    summary: "Accept the next dialog (a prompt gets text, default its own)",
    positional: [{ name: "text", required: false }],
    flags: [],
    run: (ctx, a) => cmdDialog(ctx, true, a.positional[0]),
  },
  {
    name: "dialog-dismiss",
    summary: "Dismiss the next dialog",
    positional: [],
    flags: [],
    run: (ctx) => cmdDialog(ctx, false),
  },
];
