// Snapshot: walk the page, assign eN refs to interactive elements,
// and return a compact human- and agent-readable representation.
//
// The script itself lives in page-scripts.ts; it runs inside the page via
// view.evaluate() so it stays in-process and doesn't require a second
// round-trip. The returned JSON is then formatted as YAML (a stripped-down
// subset we generate by hand — no dep needed) or raw JSON.

import type { Ref } from "./state.ts";

export interface SnapshotResult {
  url: string;
  title: string;
  refs: Ref[];
}

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function refLine(r: Ref, level: number): string {
  let line = `${indent(level)}- ${r.role} "${escapeQuoted(r.name)}": [ref=${r.id}]`;
  if (r.href) line += ` ${r.href}`;
  else if (r.value) line += ` "${escapeQuoted(r.value)}"`;
  return line;
}

/**
 * Render aria-tree-flavored YAML matching playwright-cli `snapshot`.
 *
 * Refs carry a `path` of landmark ancestors (e.g. `main`, `navigation`,
 * `form`, `list`). We render those landmarks as parent nodes, with refs as
 * leaves. `depth` clips the path: depth=1 is flat (root only), depth=2
 * permits one level of landmark nesting, etc. Default (undefined) is no clip.
 */
export function toYaml(snap: SnapshotResult, depth?: number): string {
  const maxAncestors =
    typeof depth === "number" && depth >= 1 ? depth - 1 : Infinity;
  const out: string[] = ["- generic:"];

  // Walk refs in order, maintaining a stack of currently-open landmark nodes.
  // When the next ref's clipped path shares a prefix with the open stack, we
  // reuse it; otherwise we close back to the shared prefix and open new nodes.
  const openStack: { role: string; name: string }[] = [];

  for (const r of snap.refs) {
    const fullPath = r.path ?? [];
    const path = fullPath.slice(0, maxAncestors);

    // Find shared prefix length with openStack.
    let shared = 0;
    while (
      shared < openStack.length &&
      shared < path.length &&
      openStack[shared]!.role === path[shared]!.role &&
      openStack[shared]!.name === path[shared]!.name
    ) {
      shared++;
    }
    // Pop divergent suffix and push new nodes.
    openStack.length = shared;
    for (let k = shared; k < path.length; k++) {
      const node = path[k]!;
      // Level of this landmark node: 1 (under "- generic:") + k.
      out.push(`${indent(1 + k)}- ${node.role} "${escapeQuoted(node.name)}":`);
      openStack.push(node);
    }
    // Ref leaf level: 1 + openStack.length (children of the deepest open node,
    // or of "- generic:" when stack is empty).
    out.push(refLine(r, 1 + openStack.length));
  }

  return out.join("\n") + "\n";
}

/** JSON form for `--json`. Selector is included for debugging. */
export function toJson(snap: SnapshotResult): string {
  const refs = snap.refs.map((r) => {
    const o: Record<string, unknown> = {
      ref: r.id,
      role: r.role,
      name: r.name,
      selector: r.selector,
    };
    if (r.href) o.href = r.href;
    if (r.value) o.value = r.value;
    if (r.path && r.path.length > 0) o.path = r.path;
    return o;
  });
  return JSON.stringify({ url: snap.url, title: snap.title, refs });
}
