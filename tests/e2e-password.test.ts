// End-to-end: `snapshot` never reveals a password field's value, neither as
// the field's value child, nor in the saved ref's `value` in state.json, nor
// through another element's accessible name. A deliberate difference from
// playwright-cli, which prints it. Spec:
// docs/superpowers/specs/2026-09-26-hide-passwords-design.md.
//
// Both `fill <ref> <text>` and `fill <ref> --stdin` (with an injected stdin reader).
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-password.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdFill } from "../src/commands/interaction.ts";
import { cmdClose, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState, sessionsRoot } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;

const SECRET = "hunter2-TOPSECRET";
const PIN = "PIN-UPPERCASE-TYPE-4711";
const CODE = "COMBO-ROLE-SECRET-99";
const USER = "alice-visible";

// Password fields with a lowercase type, an uppercase type and an explicit
// combobox role; buttons named through aria-labelledby by each of them; and a
// plain text field whose value must still show.
const PAGE = `<!doctype html><html><head><title>Login</title></head><body>
<label for="pw">Password</label><input id="pw" type="password">
<label for="pin">PIN</label><input id="pin" type="PASSWORD">
<input id="code" type="password" role="combobox" aria-label="Code">
<label for="user">User</label><input id="user" type="text">
<button aria-labelledby="pw">Go</button>
<button aria-labelledby="pin">Pin go</button>
<button aria-labelledby="code">Code go</button>
</body></html>`;

/** The tree text inside the ```yaml fence of `snapshot`'s output. */
function tree(out: string): string {
  const m = out.match(/\n```yaml\n([\s\S]*)\n```$/);
  if (!m) throw new Error(`no yaml fence in snapshot output:\n${out}`);
  return m[1]!;
}

const secrets = [SECRET, PIN, CODE];

runOrSkip("e2e: snapshot never reveals a password field's value (backend from resolveBackend)", () => {
  const ctx: CommandContext = { session: "password", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let plain: string;
  let json: string;
  let stateText: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-password-"));
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
    for (const r of (await loadState(ctx.session))!.refs) ids[r.name] = r.id;
    await cmdFill(ctx, ids.Password!, SECRET);
    await cmdFill(ctx, ids.PIN!, PIN);
    await cmdFill(ctx, ids.Code!, CODE);
    await cmdFill(ctx, ids.User!, USER);
    plain = await cmdSnapshot(ctx);
    json = await cmdSnapshot({ ...ctx, json: true });
    stateText = await Bun.file(join(sessionsRoot(), ctx.session, "state.json")).text();
  }, 60_000);

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  test("the fills reached the page (otherwise the absence checks prove nothing)", () => {
    for (const name of ["Password", "PIN", "Code", "User"]) expect(ids[name]).toMatch(/^e\d+$/);
    expect(plain).toContain(`: ${USER}`);
  });

  for (const s of secrets) {
    test(`plain snapshot does not contain the secret ${s}`, () => {
      expect(plain).not.toContain(s);
    });
    test(`snapshot --json does not contain the secret ${s}`, () => {
      expect(json).not.toContain(s);
    });
    test(`state.json does not contain the secret ${s}`, () => {
      expect(stateText).not.toContain(s);
    });
  }

  test("a filled password field prints as a leaf with its label name", () => {
    const lines = tree(plain).split("\n").map((l) => l.trim());
    expect(lines).toContain(`- textbox "Password" [ref=${ids.Password}]`);
    expect(lines).toContain(`- textbox "PIN" [ref=${ids.PIN}]`);
    expect(lines).toContain(`- combobox "Code" [ref=${ids.Code}]`);
  });

  test("aria-labelledby a password field adds nothing to a button's name", () => {
    const lines = tree(plain).split("\n").map((l) => l.trim());
    for (const name of ["Go", "Pin go", "Code go"]) {
      expect(lines.some((l) => l.startsWith(`- button ${JSON.stringify(name)} [ref=e`))).toBe(true);
    }
  });

  test("a text field still shows its value", () => {
    const lines = tree(plain).split("\n").map((l) => l.trim());
    expect(lines).toContain(`- textbox "User" [active] [ref=${ids.User}]: ${USER}`);
    const saved = JSON.parse(stateText).refs.find((r: { id: string }) => r.id === ids.User);
    expect(saved.value).toBe(USER);
  });

  test("fill --stdin: the piped secret is in no snapshot output and not in state.json", async () => {
    const STDIN_SECRET = "STDIN-PIPED-SECRET-31337";
    await cmdOpen(ctx, server!.url.toString());
    await cmdSnapshot(ctx);
    const pw = (await loadState(ctx.session))!.refs.find((r) => r.name === "Password")!.id;
    const stdinCtx: CommandContext = { ...ctx, readStdin: async () => `${STDIN_SECRET}\n` };
    await cmdFill(stdinCtx, pw, undefined, { stdin: true });
    // The fill reached the field, so the absence checks below mean something.
    expect(await cmdEval(ctx, "document.getElementById('pw').value")).toBe(STDIN_SECRET);
    const p = await cmdSnapshot(ctx);
    const j = await cmdSnapshot({ ...ctx, json: true });
    const st = await Bun.file(join(sessionsRoot(), ctx.session, "state.json")).text();
    expect(p).not.toContain(STDIN_SECRET);
    expect(j).not.toContain(STDIN_SECRET);
    expect(st).not.toContain(STDIN_SECRET);
    expect(tree(p).split("\n").map((l) => l.trim())).toContain(`- textbox "Password" [active] [ref=${pw}]`);
  }, 60_000);

  test("the saved refs of password fields carry no value", () => {
    const refs = JSON.parse(stateText).refs as Array<{ id: string; value?: string }>;
    for (const name of ["Password", "PIN", "Code"]) {
      expect(refs.find((r) => r.id === ids[name])).not.toHaveProperty("value");
    }
  });
});
