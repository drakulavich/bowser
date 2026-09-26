// F36 smoke test against the real `bowser mcp` process and a real WebKit
// daemon: a slow eval on one session must not hold up a ping.
//
// Skipped by default. Enable with BOWSER_E2E=1.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

runOrSkip("e2e: bowser mcp answers ping while a call runs", () => {
  test("ping answers before a slow eval on session A", async () => {
    const home = await mkdtemp(join(tmpdir(), "bowser-e2e-mcp-"));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "mcp"], {
      env: { ...process.env, HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seen: Array<{ id: unknown; at: number; msg: any }> = [];
    /** Read stdout until a response with this id arrives. */
    const waitFor = async (id: number, ms: number) => {
      const deadline = Date.now() + ms;
      while (!seen.some((s) => s.id === id)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no response for id ${id} within ${ms} ms`);
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(left).then(() => ({ done: true as const, value: undefined })),
        ]);
        if (next.done) throw new Error(`stdout closed before id ${id}`);
        buf += decoder.decode(next.value);
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const msg = JSON.parse(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          seen.push({ id: msg.id, at: Date.now(), msg });
        }
      }
      return seen.find((s) => s.id === id)!;
    };
    const send = (msg: object) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
      proc.stdin.flush();
    };
    const call = (id: number, name: string, args: object) =>
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

    try {
      const page = "data:text/html;charset=utf-8," + encodeURIComponent("<title>MCP</title><p>hi</p>");
      call(1, "open", { url: page, session: "A" });
      expect((await waitFor(1, 20_000)).msg.result.isError).toBeUndefined();

      // A synchronous busy loop keeps the page (and so the call) busy ~1.5 s.
      const slow = "(() => { const t = Date.now(); while (Date.now() - t < 1500); return 7; })()";
      const sentAt = Date.now();
      call(2, "eval", { expression: slow, session: "A" });
      send({ jsonrpc: "2.0", id: 3, method: "ping" });

      const ping = await waitFor(3, 5_000);
      const evalRes = await waitFor(2, 10_000);
      expect(ping.msg).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
      expect(ping.at - sentAt).toBeLessThan(1000);
      expect(ping.at).toBeLessThan(evalRes.at);
      expect(evalRes.msg.result.content[0].text).toContain("7");
    } finally {
      try {
        call(9, "close", { session: "A" });
        await waitFor(9, 10_000);
      } catch {}
      proc.kill();
      await proc.exited;
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);
});
