// End-to-end: non-ASCII text over the daemon socket's ~8 KB read size keeps
// every character (#75, ET-04). Each socket read was decoded on its own, so a
// character split between two reads became U+FFFD, in both directions:
// daemon to CLI (a long `eval` result, a snapshot) and CLI to daemon (a long
// `fill`). Every case is reported as success, so the check is the text.
//
// macOS only (WebKit is). Run with: BOWSER_E2E=1 bun test tests/e2e-utf8.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

/** Mixed 2-, 3- and 4-byte characters, so some read boundary lands inside one. */
const WORDS = ["é😀", "Жук", "日本語", "ありがとう", "ẞtraße"];
const long = (n: number) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ");

const PAGE = `<!doctype html><meta charset="utf-8"><title>utf8</title>
<input aria-label="Box">
${Array.from({ length: 800 }, (_, i) => `<button>${WORDS[i % WORDS.length]} ${i}</button>`).join("\n")}`;

runOrSkip("e2e: non-ASCII text over the daemon socket (#75)", () => {
  const ctx: CommandContext = { session: `utf8-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-utf8-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    await cmdOpen(ctx, server.url.toString());
  }, 30_000);

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  test("a long non-ASCII eval result comes back whole", async () => {
    const out = await cmdEval(ctx, "'é😀'.repeat(2000)");
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain("é😀".repeat(2000));
  });

  test("a long non-ASCII snapshot comes back whole", async () => {
    const out = await cmdSnapshot(ctx);
    expect(out).not.toContain("\uFFFD");
    for (let i = 0; i < 800; i++) expect(out).toContain(`button "${WORDS[i % WORDS.length]} ${i}"`);
  });

  test("a long non-ASCII fill reaches the page whole", async () => {
    await cmdSnapshot(ctx);
    const box = (await loadState(ctx.session))!.refs.find((r) => r.name === "Box")!.id;
    const text = long(2000);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(16_000);
    await cmdFill(ctx, box, text);
    // Asked in the page, so the answer is short ASCII: only the way in is tested.
    expect(await cmdEval(ctx, "[...document.querySelector('input').value].filter((c) => c === '\\uFFFD').length")).toMatch(/^0$/m);
    expect(await cmdEval(ctx, "document.querySelector('input').value.length")).toMatch(new RegExp(`^${text.length}$`, "m"));
    const value = await cmdEval(ctx, "document.querySelector('input').value");
    expect(value).not.toContain("\uFFFD");
    expect(value).toContain(text);
  }, 60_000);
});
