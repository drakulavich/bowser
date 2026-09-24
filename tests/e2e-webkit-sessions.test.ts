// Two named WebKit sessions at once, the ET-02 scenario from
// docs/superpowers/exploratory-testing/2026-09-06-session-log.md: an action in
// one session once left *both* pages blank (`- generic`, `about:blank`,
// localStorage refused as insecure). It did not reproduce on Bun 1.4.0 or
// 1.4.2 (2026-09-24); this pins that both pages survive, so a recurrence fails
// here instead of in an agent's session.
//
// macOS only (webkit is a macOS backend). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-webkit-sessions.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick, cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

runOrSkip("e2e: two WebKit sessions at once (ET-02)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origBackend: string | undefined;
  let server: { stop: () => void } | undefined;
  let url: string;

  const a: CommandContext = { session: "et02-a", json: false };
  const b: CommandContext = { session: "et02-b", json: false };

  beforeAll(async () => {
    origHome = process.env.HOME;
    origBackend = process.env.BOWSER_BACKEND;
    tmp = await mkdtemp(join(tmpdir(), "bowser-webkit-sessions-"));
    process.env.HOME = tmp;
    process.env.BOWSER_BACKEND = "webkit"; // the daemons inherit the live env
    const todo = Bun.file(join(import.meta.dir, "fixtures/todo-app.html"));
    // One origin for both, as in the original report: localStorage must still
    // be per session.
    const s = Bun.serve({ port: 0, fetch: () => new Response(todo) });
    server = { stop: () => s.stop(true) };
    url = s.url.toString();
  });

  afterAll(async () => {
    for (const ctx of [a, b]) try { await cmdClose(ctx); } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origBackend === undefined) delete process.env.BOWSER_BACKEND;
    else process.env.BOWSER_BACKEND = origBackend;
    await rm(tmp, { recursive: true, force: true });
  });

  async function refNamed(ctx: CommandContext, name: string): Promise<string> {
    const r = (await loadState(ctx.session))?.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in ${ctx.session}'s last snapshot`);
    return r.id;
  }

  test("an action in one session leaves both pages alive", async () => {
    await cmdOpen(a, url);
    await cmdOpen(b, url);
    await cmdSnapshot(a);
    await cmdSnapshot(b);
    expect(await cmdEval(a, "(localStorage.setItem('owner', 'A'), localStorage.getItem('owner'))")).toBe("A");
    expect(await cmdEval(b, "(localStorage.setItem('owner', 'B'), localStorage.getItem('owner'))")).toBe("B");

    await cmdFill(a, await refNamed(a, "New todo"), "probe");
    await cmdClick(a, await refNamed(a, "Add"));

    // ET-02 showed success from both commands, then a blank tree in both
    // sessions. Read every page back instead of trusting the replies.
    expect(await cmdSnapshot(a)).toContain(`checkbox "Toggle probe"`);
    const other = await cmdSnapshot(b);
    expect(other).toContain(`textbox "New todo"`);
    expect(other).not.toContain("Toggle probe");
    for (const [ctx, owner] of [[a, "A"], [b, "B"]] as const) {
      expect(await cmdEval(ctx, "location.href")).toBe(url);
      expect(await cmdEval(ctx, "localStorage.getItem('owner')")).toBe(owner);
    }
  });
});
