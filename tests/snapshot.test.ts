// Snapshot rendering, through `cmdSnapshot` with a fake daemon whose
// `evaluate` returns a hand-built walker result. Expected texts are copied
// from real playwright-cli 0.1.13 captures (spec 2026-09-25, research dir
// pw-*.txt), so a pass here means byte parity with playwright-cli's output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "../src/commands/context.ts";
import { cmdSnapshot } from "../src/commands/snapshot.ts";
import type { AriaNode, SnapshotResult } from "../src/snapshot.ts";
import { loadState } from "../src/state.ts";
import { fakeClient } from "./helpers/fake-client.ts";

let tmp: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  tmp = await mkdtemp(join(tmpdir(), "bowser-snaptest-"));
  process.env.HOME = tmp;
});

afterAll(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  await rm(tmp, { recursive: true, force: true });
});

type Attrs = Omit<AriaNode, "role" | "name" | "children">;

/** One aria node: role, name, attributes, then children (nodes or text). */
function n(role: string, name = "", attrs: Attrs = {}, ...children: Array<AriaNode | string>): AriaNode {
  return { role, name, ...attrs, children };
}

function page(tree: Array<AriaNode | string>, over: Partial<SnapshotResult> = {}): SnapshotResult {
  return { url: "http://localhost:49731/x.html", title: "X", tree, refs: [], ...over };
}

async function snapshot(
  snap: SnapshotResult,
  opts: { depth?: string; filename?: string; json?: boolean } = {},
): Promise<string> {
  const c = fakeClient({ evaluate: () => snap });
  const ctx: CommandContext = {
    session: "snap-" + Math.random().toString(36).slice(2, 8),
    json: opts.json ?? false,
    connect: async () => c,
  };
  return cmdSnapshot(ctx, { depth: opts.depth, filename: opts.filename });
}

/** The ```yaml block of a wrapped snapshot, i.e. the tree text alone. */
function treeOf(out: string): string {
  const start = out.indexOf("```yaml\n") + "```yaml\n".length;
  return out.slice(start, out.lastIndexOf("\n```"));
}

// pw-todo-app-toggled.txt, as walker data.
const todoTree: AriaNode = n("generic", "", { active: true, ref: "e1" },
  n("heading", "Todos", { level: 1, ref: "e2" }),
  n("generic", "", { ref: "e3" },
    n("textbox", "New todo", { ref: "e4", props: { placeholder: "What needs doing?" } }),
    n("button", "Add", { ref: "e5", cursor: true }),
  ),
  n("list", "Todo list", { ref: "e6" },
    n("listitem", "", { ref: "e14" },
      n("checkbox", "Toggle buy milk", { checked: true, ref: "e15" }),
      n("generic", "", { ref: "e16" }, "buy milk"),
    ),
  ),
  n("generic", "", { ref: "e8" },
    n("generic", "", { ref: "e9" }, "0 items left"),
    n("button", "Clear completed", { ref: "e10", cursor: true }),
  ),
);

// pw-todo-app-toggled.txt minus its `- Console:` line and trailing newline.
const todoExpected = [
  "### Page",
  "- Page URL: http://localhost:49731/todo-app.html",
  "- Page Title: Bowser Todo",
  "### Snapshot",
  "```yaml",
  "- generic [active] [ref=e1]:",
  "  - heading \"Todos\" [level=1] [ref=e2]",
  "  - generic [ref=e3]:",
  "    - textbox \"New todo\" [ref=e4]:",
  "      - /placeholder: What needs doing?",
  "    - button \"Add\" [ref=e5] [cursor=pointer]",
  "  - list \"Todo list\" [ref=e6]:",
  "    - listitem [ref=e14]:",
  "      - checkbox \"Toggle buy milk\" [checked] [ref=e15]",
  "      - generic [ref=e16]: buy milk",
  "  - generic [ref=e8]:",
  "    - generic [ref=e9]: 0 items left",
  "    - button \"Clear completed\" [ref=e10] [cursor=pointer]",
  "```",
].join("\n");

const todoPage = page([todoTree], {
  url: "http://localhost:49731/todo-app.html",
  title: "Bowser Todo",
});

// pw-kitchen-sink.txt, as walker data.
const kitchenSink: AriaNode = n("main", "", { ref: "e2" },
  n("heading", "Kitchen Sink", { level: 1, ref: "e3" }),
  n("generic", "", { ref: "e4" },
    n("textbox", "Name", { ref: "e5", props: { placeholder: "Your name" } }),
    n("combobox", "Color", { ref: "e6" },
      n("option", "red", { selected: true }),
      n("option", "blue"),
    ),
    n("checkbox", "Agree", { ref: "e7" }),
    n("button", "Submit", { ref: "e8" }),
  ),
  n("paragraph"),
  n("button", "Hover me", { ref: "e9" }),
  n("paragraph"),
  n("paragraph"),
  n("paragraph", "", { ref: "e10" }, "1280x720"),
  n("link", "Page two", { ref: "e11", cursor: true, props: { url: "/two" } }),
);

const kitchenSinkTree = [
  "- main [ref=e2]:",
  "  - heading \"Kitchen Sink\" [level=1] [ref=e3]",
  "  - generic [ref=e4]:",
  "    - textbox \"Name\" [ref=e5]:",
  "      - /placeholder: Your name",
  "    - combobox \"Color\" [ref=e6]:",
  "      - option \"red\" [selected]",
  "      - option \"blue\"",
  "    - checkbox \"Agree\" [ref=e7]",
  "    - button \"Submit\" [ref=e8]",
  "  - paragraph",
  "  - button \"Hover me\" [ref=e9]",
  "  - paragraph",
  "  - paragraph",
  "  - paragraph [ref=e10]: 1280x720",
  "  - link \"Page two\" [ref=e11] [cursor=pointer]:",
  "    - /url: /two",
].join("\n");

// pw-kitchen-sink-depth1.txt's tree.
const kitchenSinkDepth1 = [
  "- main [ref=e2]:",
  "  - heading \"Kitchen Sink\" [level=1] [ref=e3]",
  "  - generic [ref=e4]",
  "  - paragraph",
  "  - button \"Hover me\" [ref=e9]",
  "  - paragraph",
  "  - paragraph",
  "  - paragraph [ref=e10]: 1280x720",
  "  - link \"Page two\" [ref=e11] [cursor=pointer]:",
  "    - /url: /two",
].join("\n");

describe("snapshot wrapper", () => {
  test("prints playwright-cli's ### Page / ### Snapshot wrapper byte-for-byte (todo app)", async () => {
    expect(await snapshot(todoPage)).toBe(todoExpected);
  });

  test("omits the Page Title line when the title is empty", async () => {
    const out = await snapshot(page([n("button", "Go", { ref: "e1" })], { url: "http://h/", title: "" }));
    expect(out).toBe(
      "### Page\n- Page URL: http://h/\n### Snapshot\n```yaml\n- button \"Go\" [ref=e1]\n```",
    );
  });

  test("prints URL and title raw, without quoting", async () => {
    const out = await snapshot(page([n("button", "Go")], { title: 'Probe "quotes" & stuff' }));
    expect(out).toContain('\n- Page Title: Probe "quotes" & stuff\n');
  });

  test("--json prints only { snapshot: <tree> }, pretty-printed, no url/title/refs", async () => {
    const out = await snapshot(page([kitchenSink], { refs: [
      { id: "e2", selector: "main", role: "main", name: "", tag: "main" },
    ] }), { json: true });
    expect(out).toBe(JSON.stringify({ snapshot: kitchenSinkTree }, null, 2));
  });

  test("--filename writes exactly what would be printed and returns 'wrote <f>'", async () => {
    const file = join(tmp, "snap.md");
    expect(await snapshot(todoPage, { filename: file })).toBe(`wrote ${file}`);
    // The CLI prints the command's text plus one newline; the file matches stdout.
    expect(await Bun.file(file).text()).toBe(todoExpected + "\n");
  });

  test("saves every ref from the walker result to state.json", async () => {
    const refs = [
      { id: "e5", selector: "form > button", role: "button", name: "Add", tag: "button" },
      { id: "e11", selector: "a", role: "link", name: "Page two", tag: "a", href: "/two" },
    ];
    const c = fakeClient({ evaluate: () => page([], { refs }) });
    await cmdSnapshot({ session: "snap-state", json: false, connect: async () => c }, {});
    const state = await loadState("snap-state");
    expect(state?.refs).toEqual(refs);
  });
});

describe("snapshot key", () => {
  test("prints every attribute in playwright-cli's fixed order", async () => {
    const all = n("checkbox", "X", {
      checked: "mixed", disabled: true, expanded: true, active: true, level: 2,
      pressed: "mixed", selected: true, ref: "e1", cursor: true,
    });
    expect(treeOf(await snapshot(page([all])))).toBe(
      "- checkbox \"X\" [checked=mixed] [disabled] [expanded] [active] [level=2] [pressed=mixed] [selected] [ref=e1] [cursor=pointer]",
    );
  });

  test("checked: true and pressed: true print bare [checked] / [pressed]", async () => {
    const tree = treeOf(await snapshot(page([
      n("radio", "Radio A", { checked: true, ref: "e20" }),
      n("button", "Pressed", { pressed: true, ref: "e17" }),
    ])));
    expect(tree).toBe("- radio \"Radio A\" [checked] [ref=e20]\n- button \"Pressed\" [pressed] [ref=e17]");
  });

  test("omits an empty name and JSON-encodes a non-empty one", async () => {
    const tree = treeOf(await snapshot(page([
      n("paragraph"),
      n("link", 'Say "hi"', { ref: "e4", props: { url: "#x" } }),
      n("button", "back\\slash"),
    ])));
    expect(tree).toBe([
      "- paragraph",
      "- link \"Say \\\"hi\\\"\" [ref=e4]:",
      "  - /url: \"#x\"",
      "- button \"back\\\\slash\"",
    ].join("\n"));
  });

  test("single-quotes a key that needs YAML quoting, doubling inner single quotes", async () => {
    const tree = treeOf(await snapshot(page([
      n("heading", "Sub: title", { level: 2, ref: "e6" }),
      n("button", "Key: value", { ref: "e15" }, "x"),
      n("heading", "It's: here", { level: 3 }),
    ])));
    expect(tree).toBe([
      "- 'heading \"Sub: title\" [level=2] [ref=e6]'",
      "- 'button \"Key: value\" [ref=e15]': x",
      "- 'heading \"It''s: here\" [level=3]'",
    ].join("\n"));
  });
});

describe("snapshot values", () => {
  test("double-quotes values YAML would misread and leaves the rest bare (pw-probe)", async () => {
    const tree = treeOf(await snapshot(page([
      n("paragraph", "", { ref: "e10" }, "- starts with dash"),
      n("paragraph", "", { ref: "e11" }, "42"),
      n("paragraph", "", { ref: "e12" }, "yes"),
      n("paragraph", "", { ref: "e13" }, "a # hash"),
      n("paragraph", "", { ref: "e14" }, "back\\slash and \"dq\" and 'sq'"),
      n("paragraph", "", {}, "color:blue"),
      n("link", "Say", { props: { url: "#x" } }),
    ])));
    expect(tree).toBe([
      "- paragraph [ref=e10]: \"- starts with dash\"",
      "- paragraph [ref=e11]: \"42\"",
      "- paragraph [ref=e12]: \"yes\"",
      "- paragraph [ref=e13]: \"a # hash\"",
      "- paragraph [ref=e14]: back\\slash and \"dq\" and 'sq'",
      "- paragraph: color:blue",
      "- link \"Say\":",
      "  - /url: \"#x\"",
    ].join("\n"));
  });

  test("escapes a newline or tab inside a double-quoted value", async () => {
    const tree = treeOf(await snapshot(page([
      n("paragraph", "", {}, "a\nb"),
      n("paragraph", "", {}, "a\tb \"q\""),
    ])));
    expect(tree).toBe("- paragraph: \"a\\nb\"\n- paragraph: \"a\\tb \\\"q\\\"\"");
  });
});

describe("snapshot line shapes", () => {
  test("leaf, inline text, and block with props before children and '- text:' lines", async () => {
    const tree = treeOf(await snapshot(page([
      n("paragraph"),
      n("paragraph", "", { ref: "e10" }, "1280x720"),
      n("paragraph", "", { ref: "e8" },
        "Hello bold world",
        n("link", "inline link", { ref: "e9", cursor: true, props: { url: "/in" } }),
        "tail.",
      ),
      n("textbox", "Search", { props: { url: "/u", placeholder: "Type" } }),
      "top-level text",
    ])));
    expect(tree).toBe([
      "- paragraph",
      "- paragraph [ref=e10]: 1280x720",
      "- paragraph [ref=e8]:",
      "  - text: Hello bold world",
      "  - link \"inline link\" [ref=e9] [cursor=pointer]:",
      "    - /url: /in",
      "  - text: tail.",
      "- textbox \"Search\":",
      "  - /url: /u",
      "  - /placeholder: Type",
      "- text: top-level text",
    ].join("\n"));
  });

  test("a node with props and one text child is block form, not inline", async () => {
    const tree = treeOf(await snapshot(page([
      n("textbox", "Name", { ref: "e5", props: { placeholder: "Your name" } }, "Ann"),
    ])));
    expect(tree).toBe("- textbox \"Name\" [ref=e5]:\n  - /placeholder: Your name\n  - text: Ann");
  });
});

describe("snapshot --depth", () => {
  test("--depth=1 cuts the kitchen sink exactly like playwright-cli", async () => {
    expect(treeOf(await snapshot(page([kitchenSink]), { depth: "1" }))).toBe(kitchenSinkDepth1);
  });

  test("--depth=0 and no --depth both print the whole tree", async () => {
    expect(treeOf(await snapshot(page([kitchenSink])))).toBe(kitchenSinkTree);
    expect(treeOf(await snapshot(page([kitchenSink]), { depth: "0" }))).toBe(kitchenSinkTree);
  });

  test("--depth rejects negative, fractional and non-numeric values as a usage error", async () => {
    for (const bad of ["-1", "1.5", "abc", ""]) {
      await expect(snapshot(page([kitchenSink]), { depth: bad })).rejects.toThrow(/^usage: --depth=N /);
    }
  });
});
