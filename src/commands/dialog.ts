// Answering JavaScript dialogs: dialog-accept [text] and dialog-dismiss.
// With a dialog open (chrome) they answer it; otherwise they set the answer
// the daemon gives the next dialog on the page, once.

import type { Command } from "../cli/registry.ts";
import { dialogJson, dialogLine, reply, withClient, type CommandContext } from "./context.ts";

export async function cmdDialog(ctx: CommandContext, accept: boolean, text?: string): Promise<string> {
  return withClient(ctx, async (c) => {
    const { answered } = await c.request("dialog-answer", text === undefined ? [accept] : [accept, text]);
    if (answered) return reply(ctx, { ok: true, dialogs: [dialogJson(answered)] }, dialogLine(answered));
    const verb = accept ? "accepted" : "dismissed";
    return reply(ctx, { ok: true, next: verb }, `next dialog will be ${verb}`);
  });
}

export const COMMANDS: Command[] = [
  {
    name: "dialog-accept",
    summary: "Accept the open dialog (a prompt gets text, default its own), or the next one",
    positional: [{ name: "text", required: false }],
    flags: [],
    run: (ctx, a) => cmdDialog(ctx, true, a.positional[0]),
  },
  {
    name: "dialog-dismiss",
    summary: "Dismiss the open dialog, or the next one",
    positional: [],
    flags: [],
    run: (ctx) => cmdDialog(ctx, false),
  },
];
