// Snapshot: walk the page, assign @eN refs to interactive elements,
// and return a compact human- and agent-readable representation.
//
// Runs inside the page via view.evaluate() so it stays in-process and doesn't
// require a second round-trip. The returned JSON is then formatted as YAML
// (a stripped-down subset we generate by hand — no dep needed) or raw JSON.

import type { Ref } from "./state.ts";

// This function is serialized to a string and executed inside the page.
// Keep it self-contained: no imports, no external references.
//
// For each interactive element we compute a *stable* CSS path based on
// nth-of-type chains rooted at <html>. This survives a page reload (unlike
// data-* attributes we'd have to inject), which matters because Bowser's
// one-shot mode re-navigates between commands.
export const SNAPSHOT_SCRIPT = `(() => {
  const INTERACTIVE = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=tab],[role=menuitem],[contenteditable="true"]';

  function cssPath(el) {
    // Prefer a unique id if present and safe.
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const byId = document.querySelectorAll('#' + el.id);
      if (byId.length === 1) return '#' + el.id;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
      node = parent;
    }
    return 'html > ' + parts.join(' > ');
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  function accName(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('value') ||
      (el.innerText || el.textContent || '').trim().slice(0, 80) ||
      ''
    ).replace(/\\s+/g, ' ').trim();
  }

  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  }

  const refs = [];
  let i = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    i += 1;
    refs.push({
      id: '@e' + i,
      selector: cssPath(el),
      role: role(el),
      name: accName(el).slice(0, 120),
      tag: el.tagName.toLowerCase(),
    });
  }

  return {
    url: location.href,
    title: document.title,
    refs,
  };
})()`;

export interface SnapshotResult {
  url: string;
  title: string;
  refs: Ref[];
}

/** Render a snapshot as compact, agent-readable YAML. */
export function toYaml(snap: SnapshotResult): string {
  const lines: string[] = [];
  lines.push(`url: ${yamlString(snap.url)}`);
  lines.push(`title: ${yamlString(snap.title)}`);
  lines.push(`refs:`);
  for (const r of snap.refs) {
    // One-line flow per ref keeps the snapshot short for agents.
    lines.push(
      `  - { id: ${r.id}, role: ${r.role}, name: ${yamlString(r.name)} }`,
    );
  }
  return lines.join("\n") + "\n";
}

function yamlString(s: string): string {
  // Always quote; escape backslash and double-quote.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
