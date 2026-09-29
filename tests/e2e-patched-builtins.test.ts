// End-to-end: a page that patches builtins the way legacy libraries do still
// gets a true snapshot, eval result, click and fill (#76, ET-11). Prototype.js
// 1.6 sets Array.prototype.toJSON and replaces Array.prototype.map/find/
// filter/every/some/entries with its Enumerable versions and Object.keys
// with a for-in one. bowser's answer from the page crossed through the
// page's JSON, so the snapshot printed `text: p` … `text: o`, `eval
// "['x','y']"` printed `proto`, and click/fill failed with
// `state.refs.find is not a function`.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-patched-builtins.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

// What Prototype.js 1.6 does to the builtins bowser's scripts touch, with
// its semantics: Enumerable methods call the iterator with (value, index)
// only; `entries` is `toArray`; `toJSON` answers a string. Plus the other
// shape ET-11 found: a page-wide Object.prototype.toJSON.
const PROTOTYPE = String.raw`
  (function () {
    var A = Array.prototype, each = A.forEach;
    function detect(it, ctx) { var r; each.call(this, function (v, i) { if (r === undefined && it.call(ctx, v, i)) r = v; }); return r; }
    function collect(it, ctx) { var out = []; each.call(this, function (v, i) { out.push(it ? it.call(ctx, v, i) : v); }); return out; }
    function findAll(it, ctx) { var out = []; each.call(this, function (v, i) { if (it.call(ctx, v, i)) out.push(v); }); return out; }
    function all(it, ctx) { var ok = true; each.call(this, function (v, i) { ok = ok && !!it.call(ctx, v, i); }); return ok; }
    function any(it, ctx) { var ok = false; each.call(this, function (v, i) { ok = ok || !!it.call(ctx, v, i); }); return ok; }
    A.find = detect; A.map = collect; A.filter = findAll; A.every = all; A.some = any;
    A.entries = function () { return [].concat(this); };
    A.toJSON = function () { return 'proto'; };
    String.prototype.toJSON = function () { return 'str'; };
    Object.keys = function (o) { var k = []; for (var p in o) k.push(p); return k; };
    if (location.search === '?object') Object.prototype.toJSON = function () { return {}; };
  })();`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>legacy</title>
<script>${PROTOTYPE}</script>
<label>Qty <input id="qty"></label>
<button onclick="document.title = 'bought ' + document.getElementById('qty').value">Buy</button>
<button onclick="alert('hi')">Warn</button>`;

runOrSkip("e2e: a page with patched builtins (#76)", () => {
  const ctx: CommandContext = { session: `builtins-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-builtins-"));
    process.env.HOME = tmp;
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    await rm(tmp, { recursive: true, force: true });
  });

  async function ref(name: string): Promise<string> {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)}`);
    return r.id;
  }

  for (const variant of ["", "?object"]) {
    describe(variant ? "with Object.prototype.toJSON too" : "Prototype.js-style", () => {
      beforeEach(async () => {
        await cmdOpen(ctx, server!.url.toString() + variant);
      }, 30_000);

      test("snapshot prints the page's tree", async () => {
        const out = await cmdSnapshot(ctx);
        expect(out).toContain('textbox "Qty"');
        expect(out).toContain('button "Buy"');
        expect(out).toContain('button "Warn"');
        expect(out).not.toContain("text: p");
      });

      test("eval returns the value, not the page's toJSON of it", async () => {
        expect(await cmdEval(ctx, "['x','y']")).toMatch(/^\["x","y"\]$/m);
        expect(await cmdEval(ctx, "[1,'a',{b:2}]")).toMatch(/^\[1,"a",\{"b":2\}\]$/m);
      });

      test("eval of the page's own JSON.stringify still sees the page's builtins", async () => {
        expect(await cmdEval(ctx, "JSON.stringify(['x'])")).toMatch(/^"proto"$/m);
      });

      test("a value's own toJSON, and Date's, still apply", async () => {
        expect(await cmdEval(ctx, "({ toJSON() { return 5; } })")).toMatch(/^5$/m);
        expect(await cmdEval(ctx, "[new Date(0)]")).toMatch(/^\["1970-01-01T00:00:00.000Z"\]$/m);
      });

      test("fill and click work, and a dialog is reported", async () => {
        await cmdSnapshot(ctx);
        await cmdFill(ctx, await ref("Qty"), "3");
        await cmdClick(ctx, await ref("Buy"));
        expect(await cmdEval(ctx, "document.title")).toMatch(/^bought 3$/m);
        const warned = await cmdClick(ctx, await ref("Warn"));
        expect(warned).toContain("### Modal state");
        expect(warned).toContain("hi");
        // The page's patches are still in place after bowser's reads.
        expect(await cmdEval(ctx, "typeof Array.prototype.toJSON")).toMatch(/^function$/m);
      });
    });
  }
});
