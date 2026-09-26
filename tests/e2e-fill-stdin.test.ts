// End-to-end: `fill <ref> --stdin` puts a piped secret into a password field
// without it reaching the bowser process's argv or anything bowser prints.
// Spec: docs/superpowers/specs/2026-09-26-fill-stdin-design.md.
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-fill-stdin.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Login</title></head><body>
<form><label>Username <input id="user" type="text"></label>
<label>Password <input id="pw" type="password"></label></form></body></html>`;

runOrSkip("e2e: fill --stdin keeps a secret out of argv and output (backend from resolveBackend)", () => {
  const ctx: CommandContext = { session: "fillstdin", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-fillstdin-"));
    process.env.HOME = tmp;
    if (resolveBackend().kind === "chrome" && !detectChromium()) {
      throw new Error("BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found.");
    }
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    await cmdOpen(ctx, server.url.toString());
    await cmdSnapshot(ctx);
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const passwordRef = async (): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === "Password");
    if (!r) throw new Error("no ref named \"Password\" in the last snapshot");
    return r.id;
  };

  /** Run `bowser fill <ref> --stdin` as its own process and pipe `input` in
   *  after it has started, the way `op read … |` would. */
  const fillFromStdin = async (ref: string, input: string, json: boolean) => {
    const cmd = [
      process.execPath, join(import.meta.dir, "../src/cli.ts"),
      "-s", ctx.session, ...(json ? ["--json"] : []), "fill", ref, "--stdin",
    ];
    const proc = Bun.spawn({ cmd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(input);
    proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    return { argv: cmd, code, stdout, stderr };
  };

  const fieldValue = () => cmdEval({ ...ctx, json: true }, "document.querySelector('#pw').value")
    .then((out) => (JSON.parse(out) as { result: string }).result);

  for (const json of [false, true]) {
    test(`a piped secret lands in the password field and nowhere in bowser's argv or ${json ? "--json" : "plain"} output`, async () => {
      const secret = `S3cr3t-${json ? "json" : "plain"}-$(id) "q" 'q' \\ &!`;
      const ref = await passwordRef();
      const run = await fillFromStdin(ref, `${secret}\n`, json);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(await fieldValue()).toBe(secret);
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
      expect(run.argv.join("\0")).not.toContain(secret);
      expect(run.stdout.trim()).toBe(json ? JSON.stringify({ ok: true, ref }) : `filled ${ref} (textbox "Password")`);
    }, 60_000);
  }
});
