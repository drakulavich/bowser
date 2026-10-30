// End-to-end on WebKit (#267): a page that navigates while `click` waits for
// its target. Bun's selector click waited with requestAnimationFrame, which
// never fires on a page in the back-forward cache, so the click hung and the
// session was stuck.
//
// macOS only (WebKit is). Run with:
//   BOWSER_E2E=1 bun test tests/e2e-click-nav.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportFailure } from "../src/cli.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdClick } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E && process.platform === "darwin" ? describe : describe.skip;

/** Its button moves every frame, so it is never stable; the page goes to B once go answers. */
const PAGE_A = `<!doctype html><title>A</title>
<button>Go</button>
<script>
  const b = document.querySelector('button');
  let n = 0;
  (function move() { b.style.transform = 'translateX(' + (n++ % 20) + 'px)'; requestAnimationFrame(move); })();
  fetch('go').then(() => { location.href = 'b'; });
</script>`;
const PAGE_B = `<!doctype html><title>B</title>
<button onclick="document.body.dataset.clicked = 'yes'">Go</button>`;
/** Under /sealed/ both pages make their document non-extensible, so DOC_ID reads "sealed" in each (#248, #274). */
const SEAL = "<script>Object.preventExtensions(document)</script>";

runOrSkip("e2e: a page that navigates while click waits (#267)", () => {
  const ctx: CommandContext = { session: `click-nav-${process.pid}`, json: false };
  let tmp: string;
  let origHome: string | undefined;
  let origTimeout: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  let releaseGo = () => {};

  beforeAll(async () => {
    origHome = process.env.HOME;
    origTimeout = process.env.BOWSER_OP_TIMEOUT_MS;
    tmp = await mkdtemp(join(tmpdir(), "bowser-click-nav-"));
    process.env.HOME = tmp;
    // The daemon reads it when it spawns.
    process.env.BOWSER_OP_TIMEOUT_MS = "3000";
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const full = new URL(req.url).pathname;
        const sealed = full.startsWith("/sealed/");
        const path = sealed ? full.slice("/sealed".length) : full;
        if (path === "/go")
          return new Promise<Response>((r) => {
            releaseGo = () => r(new Response("ok"));
          });
        return new Response((sealed ? SEAL : "") + (path === "/b" ? PAGE_B : PAGE_A), { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try {
      await cmdClose(ctx);
    } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origTimeout === undefined) delete process.env.BOWSER_OP_TIMEOUT_MS;
    else process.env.BOWSER_OP_TIMEOUT_MS = origTimeout;
    await rm(tmp, { recursive: true, force: true });
  });

  const goRef = async (): Promise<string> => {
    await cmdSnapshot(ctx);
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === "Go");
    if (!r) throw new Error("no ref named Go in the snapshot");
    return r.id;
  };

  const navigatesDuringTheWait = async (prefix: string): Promise<void> => {
    // A new daemon's first navigation can overrun a short budget on a slow runner (see e2e-hangs openWith).
    try {
      await cmdOpen(ctx, `${base}${prefix}/a`);
    } catch (err) {
      expect(String(err)).toContain("timed out after");
      await cmdGoto(ctx, `${base}${prefix}/a`);
    }
    const onA = await goRef();

    const t0 = performance.now();
    const click = cmdClick(ctx, onA).then(
      (out) => {
        throw new Error(`expected a failure, got: ${out}`);
      },
      (err: Error) => err,
    );
    setTimeout(() => releaseGo(), 300);
    const err = await click;
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(err.message).toBe("click: the page navigated before the click; nothing was clicked, run 'bowser snapshot' to see the new page");
    expect(reportFailure(err).code).toBe(2);

    expect(await cmdEval(ctx, "location.pathname + ' ' + String(document.body.dataset.clicked)")).toBe(`${prefix}/b undefined`);
    await cmdClick(ctx, await goRef());
    expect(await cmdEval(ctx, "document.body.dataset.clicked")).toBe("yes");
  };

  test("the click fails with the navigation message, exit 2, clicks nothing, and the next click works", () => navigatesDuringTheWait(""), 30_000);
  test("the same on pages that make their document non-extensible (#274)", async () => {
    await navigatesDuringTheWait("/sealed");
    expect(await cmdEval(ctx, "Object.isExtensible(document)")).toBe("false");
  }, 30_000);
});
