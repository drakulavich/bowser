// Snapshot rendering: the page-side walker (SNAPSHOT_SCRIPT in page-scripts.ts)
// returns a SnapshotResult whose tree already carries every semantic decision
// (roles, names, text, refs, cursor). This file does layout only, in
// playwright-cli's aria-tree YAML: key, attribute order, YAML quoting,
// leaf/inline/block shapes, props, --depth, and the `### Page` wrapper.

import type { Ref } from "./state.ts";

export interface AriaNode {
  role: string;
  name: string;                    // "" = no name
  checked?: true | "mixed";
  disabled?: true;
  expanded?: true;
  active?: true;
  level?: number;
  pressed?: true | "mixed";
  selected?: true;
  ref?: string;                    // "eN"
  cursor?: true;                   // walker already applied the no-ancestor-cursor rule
  props?: { url?: string; placeholder?: string };
  children: Array<AriaNode | string>;   // strings are text lines, already normalized/merged
}

export interface SnapshotResult {
  url: string;
  title: string;
  tree: Array<AriaNode | string>;  // top level after generic collapse (usually one node)
  refs: Ref[];                     // every ref-bearing node, for state.json
}

const YAML_WORDS = ["y", "n", "yes", "no", "true", "false", "on", "off", "null"];

/** playwright's yamlStringNeedsQuotes, plus tab (spec 3.5: any control char). */
function needsQuotes(s: string): boolean {
  return s === ""
    || /^\s|\s$/.test(s)
    || /[\x00-\x1f\x7f-\x9f]/.test(s)
    || /^[-&*\],?!>|@"'#%[]/.test(s)
    || /:(\s|$)/.test(s)
    || /\s#/.test(s)
    || /[{}`]/.test(s)
    || !isNaN(Number(s))
    || YAML_WORDS.includes(s.toLowerCase());
}

const ESCAPES: Record<string, string> = {
  "\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t",
};

function quoteValue(s: string): string {
  if (!needsQuotes(s)) return s;
  return '"' + s.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) =>
    ESCAPES[c] ?? "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")) + '"';
}

function quoteKey(s: string): string {
  return needsQuotes(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

function key(n: AriaNode): string {
  let k = n.role;
  if (n.name) k += " " + JSON.stringify(n.name);
  if (n.checked) k += n.checked === "mixed" ? " [checked=mixed]" : " [checked]";
  if (n.disabled) k += " [disabled]";
  if (n.expanded) k += " [expanded]";
  if (n.active) k += " [active]";
  if (n.level) k += ` [level=${n.level}]`;
  if (n.pressed) k += n.pressed === "mixed" ? " [pressed=mixed]" : " [pressed]";
  if (n.selected) k += " [selected]";
  if (n.ref) k += ` [ref=${n.ref}]`;
  if (n.cursor) k += " [cursor=pointer]";
  return quoteKey(k);
}

/** The tree as YAML lines, no trailing newline. depth 0 = unlimited; with
 *  depth N a node at level N prints as a leaf but keeps its props and its
 *  inline text. */
export function renderTree(tree: Array<AriaNode | string>, depth = 0): string {
  const lines: string[] = [];
  const limit = depth || Infinity;
  const visit = (item: AriaNode | string, level: number): void => {
    if (level > limit) return;
    const pad = "  ".repeat(level);
    if (typeof item === "string") {
      lines.push(`${pad}- text: ${quoteValue(item)}`);
      return;
    }
    const props: Array<[string, string]> = [];
    if (item.props?.url !== undefined) props.push(["url", item.props.url]);
    if (item.props?.placeholder !== undefined) props.push(["placeholder", item.props.placeholder]);
    const head = `${pad}- ${key(item)}`;
    const [only] = item.children;
    if (!props.length && item.children.length === 1 && typeof only === "string") {
      lines.push(`${head}: ${quoteValue(only)}`);
    } else if (!props.length && (!item.children.length || level === limit)) {
      lines.push(head);
    } else {
      lines.push(`${head}:`);
      for (const [name, value] of props) lines.push(`${pad}  - /${name}: ${quoteValue(value)}`);
      for (const child of item.children) visit(child, level + 1);
    }
  };
  for (const item of tree) visit(item, 0);
  return lines.join("\n");
}

/** playwright-cli's `### Page` / `### Snapshot` wrapper, no trailing newline. */
export function renderPage(snap: SnapshotResult, depth = 0): string {
  const lines = ["### Page", `- Page URL: ${snap.url}`];
  if (snap.title) lines.push(`- Page Title: ${snap.title}`);
  lines.push("### Snapshot", "```yaml", renderTree(snap.tree, depth), "```");
  return lines.join("\n");
}
