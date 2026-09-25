// End-to-end: the page-side walker against goldens captured from
// playwright-cli 0.1.13 (Edge). Each golden in tests/fixtures/snapshots/ is the
// tree block of the matching .superpowers/research/pw-*.txt capture; the only
// edit is the ruled one in probe.yaml (the iframe is a leaf, no frame content).
// The command sequence reproduces the capture's, because refs and [active]
// depend on it; kitchen-sink is resized to the capture's 1280x720 first.
//
// coverage.yaml and contents.yaml are later captures of their fixtures of tests/fixtures/snapshot-coverage.html
// (tests/fixtures/snapshot-*.html; playwright-cli 0.1.13, Edge, same way),
// for rules the other pages miss.
//
// Documented deviations (each swaps named golden lines, see Deviation; the
// golden files stay playwright-cli's text):
// - WebKit, todo-app-added: a mouse click does not focus a <button> on macOS,
//   so [active] stays on <body> instead of moving to "Add".
// - Chromium, todo-app-toggled: bowser's `check` toggles via el.click() and
//   moves no focus, so "Add" keeps [active] where playwright-cli's real click
//   left it on <body>.
// - WebKit, kitchen-sink and probe: links without their own cursor style have
//   computed cursor `auto` on WebKit, so they print no [cursor=pointer].
//
// Skipped by default. Run with: BOWSER_E2E=1 bun test tests/e2e-snapshot.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium, resolveBackend } from "../src/backend.ts";
import type { CommandContext } from "../src/commands/context.ts";
import { cmdCheck, cmdClick, cmdFill, cmdResize } from "../src/commands/interaction.ts";
import { cmdClose, cmdGoto, cmdOpen } from "../src/commands/navigation.ts";
import { cmdEval } from "../src/commands/scripting.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import { loadState } from "../src/state.ts";

const E2E = process.env.BOWSER_E2E === "1";
const runOrSkip = E2E ? describe : describe.skip;
const FIXTURES = join(import.meta.dir, "fixtures");

async function golden(name: string): Promise<string> {
  return (await Bun.file(join(FIXTURES, "snapshots", `${name}.yaml`)).text()).replace(/\n$/, "");
}

/** A line of a golden that one backend prints differently, and what it prints
 *  instead. Each use says why; the golden itself stays playwright-cli's text. */
type Deviation = { line: string; becomes: string };

/** The golden with the given lines swapped. A deviation whose line is not in
 *  the golden throws, so a stale one cannot silently pass. */
function withDeviations(text: string, deviations: Deviation[]): string {
  const lines = text.split("\n");
  for (const d of deviations) {
    const i = lines.indexOf(d.line);
    if (i < 0) throw new Error(`deviation line not in golden: ${d.line}`);
    lines[i] = d.becomes;
  }
  return lines.join("\n");
}

/** WebKit's UA stylesheet leaves a link's computed cursor at `auto` (Chromium
 *  sets `pointer`), so on WebKit a link without an explicit `cursor` style
 *  prints no [cursor=pointer]. An engine difference, not a walker bug. The
 *  links are named so one with its own `cursor:pointer` style still counts. */
function webkitLinkCursor(golden: string, links: string[]): Deviation[] {
  const lines = golden.split("\n");
  return links.map((name) => {
    const line = lines.find((l) => l.trimStart().startsWith(`- link ${JSON.stringify(name)} `)) ?? `link ${name}`;
    return { line, becomes: line.replace(" [cursor=pointer]", "") };
  });
}

/** The tree text inside the ```yaml fence of `snapshot`'s output. */
function tree(out: string): string {
  const m = out.match(/\n```yaml\n([\s\S]*)\n```$/);
  if (!m) throw new Error(`no yaml fence in snapshot output:\n${out}`);
  return m[1]!;
}

/** Review edge cases. playwright-cli 0.1.13 (Edge) prints for this page:
 *    - generic [active] [ref=e1]:
 *      - paragraph [ref=e2]: a focusable span b
 *      - paragraph [ref=e3]: c clickable span d
 *      - paragraph [ref=e4]:
 *        - text: e
 *        - button "role span" [ref=e5]
 *        - text: f
 *      - iframe [ref=e6]:
 *        - paragraph [ref=f1e2]: x
 *      - iframe [ref=e7]:
 *        - paragraph [ref=f2e2]: "y"
 *  Its rule (toAriaNode) flattens every inline generic whose only child is a
 *  text node, focusable or clickable or not; a span with a real role stays. */
const EDGES_HTML = `<!doctype html>
<html><head><title>Edges</title></head>
<body>
  <p>a <span tabindex="0">focusable span</span> b</p>
  <p>c <span onclick="1" style="cursor:pointer">clickable span</span> d</p>
  <p>e <span role="button">role span</span> f</p>
  <iframe srcdoc="<p>x</p>" width="100" height="40" style="pointer-events:none"></iframe>
  <iframe srcdoc="<p>y</p>" width="100" height="40"></iframe>
</body></html>`;

/** A contenteditable element whose role alone (textbox on a <div>) would not
 *  let `fill` through: only the walker's `editable` flag does. Empty, because
 *  fill does not clear contenteditable content. */
const EDITABLE_HTML = `<!doctype html>
<html><head><title>Editable</title></head>
<body><div id="notes" contenteditable="true" role="textbox" aria-label="Notes" style="min-height:2em"></div></body></html>`;

runOrSkip("e2e: snapshot matches playwright-cli's goldens (backend from resolveBackend)", () => {
  const ctx: CommandContext = { session: "snapgold", json: false };
  let tmp: string;
  let origHome: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let base: string;
  let backend: "webkit" | "chrome";

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-snapshot-"));
    process.env.HOME = tmp;
    backend = resolveBackend().kind;
    if (backend === "chrome" && !detectChromium()) {
      throw new Error("BOWSER_E2E=1 resolved to the chrome backend but no Chromium binary was found.");
    }
    const pages: Record<string, string> = {
      "/todo-app.html": "todo-app.html",
      "/kitchen-sink.html": "kitchen-sink.html",
      "/probe.html": "snapshot-probe.html",
      "/coverage.html": "snapshot-coverage.html",
      "/contents.html": "snapshot-contents.html",
    };
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/editable.html") {
          return new Response(EDITABLE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (new URL(req.url).pathname === "/edges.html") {
          return new Response(EDGES_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        const file = pages[new URL(req.url).pathname];
        if (!file) return new Response("not found", { status: 404 });
        return new Response(Bun.file(join(FIXTURES, file)), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    base = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    try { await cmdClose(ctx); } catch {}
    server?.stop(true);
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const refNamed = async (name: string): Promise<string> => {
    const r = (await loadState(ctx.session))!.refs.find((x) => x.name === name);
    if (!r) throw new Error(`no ref named ${JSON.stringify(name)} in the last snapshot`);
    return r.id;
  };

  test("fresh todo app prints playwright-cli's tree", async () => {
    await cmdOpen(ctx, `${base}/todo-app.html`);
    expect(tree(await cmdSnapshot(ctx))).toBe(await golden("todo-app"));
  }, 60_000);

  test("fill + click Add through the new refs prints the added tree with sticky refs", async () => {
    // Same commands as the capture: fill e4, click e5.
    expect(await refNamed("New todo")).toBe("e4");
    expect(await refNamed("Add")).toBe("e5");
    await cmdFill(ctx, "e4", "buy milk");
    await cmdClick(ctx, "e5");
    const added = tree(await cmdSnapshot(ctx));
    // WebKit on macOS does not focus a <button> on a mouse click (platform
    // focus rules), so after clicking Add focus stays on <body>. Chromium, like
    // the Edge capture, focuses the button.
    const webkitFocus: Deviation[] = backend === "webkit" ? [
      { line: "- generic [ref=e1]:", becomes: "- generic [active] [ref=e1]:" },
      { line: '    - button "Add" [active] [ref=e5] [cursor=pointer]', becomes: '    - button "Add" [ref=e5] [cursor=pointer]' },
    ] : [];
    expect(added).toBe(withDeviations(await golden("todo-app-added"), webkitFocus));
    // Sticky: unchanged elements keep their refs, new ones continue the counter.
    expect(await refNamed("Clear completed")).toBe("e10");
    expect(await refNamed("Toggle buy milk")).toBe("e12");
  }, 60_000);

  test("check refuses the listitem ref and leaves the todo unchecked", async () => {
    // e11 is the listitem around "buy milk" (see todo-app-added.yaml).
    await expect(cmdCheck(ctx, "e11")).rejects.toThrow("ref 'e11' is not a checkbox or radio button (listitem)");
    const after = tree(await cmdSnapshot(ctx));
    expect(after).toContain('\n      - checkbox "Toggle buy milk" [ref=e12]\n');
  }, 60_000);

  test("check through the new ref prints the toggled tree", async () => {
    await cmdCheck(ctx, "e12");
    // playwright-cli's check clicks the checkbox, which takes focus and is then
    // replaced by the re-render, leaving focus on <body>. bowser's check toggles
    // through el.click(), which moves no focus, so on Chromium the Add button
    // clicked before keeps [active]. (On WebKit Add never took focus, so the
    // golden matches as is.) An action-command difference, not a walker bug.
    const chromeFocus: Deviation[] = backend === "chrome" ? [
      { line: "- generic [active] [ref=e1]:", becomes: "- generic [ref=e1]:" },
      { line: '    - button "Add" [ref=e5] [cursor=pointer]', becomes: '    - button "Add" [active] [ref=e5] [cursor=pointer]' },
    ] : [];
    expect(tree(await cmdSnapshot(ctx))).toBe(withDeviations(await golden("todo-app-toggled"), chromeFocus));
  }, 60_000);

  test("kitchen sink at 1280x720 prints playwright-cli's tree, refs restarting at e1", async () => {
    await cmdGoto(ctx, `${base}/kitchen-sink.html`);
    await cmdResize(ctx, "1280", "720");
    // The page updates its size text from the resize event, which Chromium
    // fires on its next frame; re-snapshot until it lands (refs are sticky, so
    // the extra snapshots change nothing else).
    let out = await cmdSnapshot(ctx);
    for (let i = 0; i < 40 && !out.includes(": 1280x720"); i++) {
      await Bun.sleep(50);
      out = await cmdSnapshot(ctx);
    }
    const want = await golden("kitchen-sink");
    expect(tree(out)).toBe(withDeviations(want, backend === "webkit" ? webkitLinkCursor(want, ["Page two"]) : []));
  }, 60_000);

  test("probe page: names, text merging, quoting and state attributes match playwright-cli", async () => {
    await cmdGoto(ctx, `${base}/probe.html`);
    const want = await golden("probe");
    expect(tree(await cmdSnapshot(ctx))).toBe(withDeviations(want, backend === "webkit"
      ? webkitLinkCursor(want, ["Home", 'Say "hi"', "inline link", "link"])
      : []));
  }, 60_000);

  test("inline text-only generics flatten like playwright-cli's; a pointer-events:none iframe gets no ref", async () => {
    await cmdGoto(ctx, `${base}/edges.html`);
    // Differs from playwright-cli (above) only by the ruled iframe leaves and
    // spec 3.6: playwright hard-codes pointer events on for iframes, bowser
    // requires them, so the first iframe has no ref and the second is e6.
    expect(tree(await cmdSnapshot(ctx))).toBe([
      "- generic [active] [ref=e1]:",
      "  - paragraph [ref=e2]: a focusable span b",
      "  - paragraph [ref=e3]: c clickable span d",
      "  - paragraph [ref=e4]:",
      "    - text: e",
      '    - button "role span" [ref=e5]',
      "    - text: f",
      "  - iframe",
      "  - iframe [ref=e6]",
    ].join("\n"));
  }, 60_000);

  test("fill accepts a contenteditable ref and its text changes", async () => {
    await cmdGoto(ctx, `${base}/editable.html`);
    await cmdSnapshot(ctx);
    await cmdFill(ctx, await refNamed("Notes"), "hello editable");
    expect(await cmdEval(ctx, "document.getElementById('notes').textContent")).toContain("hello editable");
  }, 60_000);

  // One page, several rules; the golden line that breaks names the rule:
  // - `button "Inert"` has no ref: pointer-events:none takes the ref away;
  // - `textbox "First name"` / `textbox "Wrapped"`: names from a <label>,
  //   by for= and by wrapping;
  // - `textbox "Email"` and `textbox "Search here"` print no /placeholder:
  //   it equals the name;
  // - `paragraph [ref=e10]` has no [cursor=pointer] though it inherits the
  //   cursor: its parent already printed it;
  // - `generic [ref=e3]` / `generic [ref=e14]` / `generic [ref=e16]`: a
  //   header or footer inside main/article is no banner/contentinfo, while the
  //   top-level ones are;
  // - `button "typed value"`: aria-labelledby pointing at an input reads its
  //   value.
  test("labels, placeholder, pointer-events, nested cursor, scoped header/footer and labelledby-value match playwright-cli", async () => {
    await cmdGoto(ctx, `${base}/coverage.html`);
    expect(tree(await cmdSnapshot(ctx))).toBe(await golden("coverage"));
  }, 60_000);

  // playwright-cli gives a display:contents element a ref when a child is
  // visible, though it has no box of its own (computeBox looks through to the
  // children). Matched for parity: the collapsed wrapper still takes e2, so
  // its button is e3; `generic [ref=e4]` and `navigation "Contents nav"
  // [ref=e7]` are display:contents themselves; a text-only one flattens.
  test("display:contents elements take a ref from a visible child, like playwright-cli", async () => {
    await cmdGoto(ctx, `${base}/contents.html`);
    expect(tree(await cmdSnapshot(ctx))).toBe(await golden("contents"));
  }, 60_000);
});
