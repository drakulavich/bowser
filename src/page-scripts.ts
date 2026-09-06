// Every JavaScript snippet bowser injects into the page. Builders take user
// input (selectors, keys, values) and embed it with JSON.stringify, which is
// what keeps a selector with quotes from breaking out of the string. This
// file imports nothing from src/ and is the only one allowed to build an
// IIFE string (tests/layers.test.ts).

// This function is serialized to a string and executed inside the page.
// Keep it self-contained: no imports, no external references.
//
// For each interactive element we compute a *stable* CSS path based on
// nth-of-type chains rooted at <html>. This survives a page reload (unlike
// data-* attributes we'd have to inject), which matters because Bowser's
// one-shot mode re-navigates between commands.
export const SNAPSHOT_SCRIPT = `(() => {
  const INTERACTIVE = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=tab],[role=menuitem],[contenteditable="true"]';
  const LANDMARK_TAGS = { main: 'main', nav: 'navigation', header: 'banner', footer: 'contentinfo', section: 'region', article: 'article', aside: 'complementary', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list' };
  const LANDMARK_ROLES = new Set(['main','navigation','banner','contentinfo','region','article','complementary','form','dialog','list','menu','menubar','tablist','search','group']);
  function cssPath(el) {
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) {
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
      el.getAttribute('aria-label') || el.getAttribute('alt') ||
      el.getAttribute('title') || el.getAttribute('placeholder') ||
      el.getAttribute('value') ||
      (el.innerText || el.textContent || '').trim().slice(0, 80) || ''
    ).replace(/\\s+/g, ' ').trim();
  }
  function role(el) {
    const r = el.getAttribute('role'); if (r) return r;
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
  function landmarkInfo(el) {
    // Returns {role, name} when el is a landmark container, else null.
    const explicit = el.getAttribute('role');
    if (explicit && LANDMARK_ROLES.has(explicit)) {
      return { role: explicit, name: accName(el).slice(0, 80) };
    }
    const tag = el.tagName.toLowerCase();
    const implied = LANDMARK_ROLES.has(tag) ? tag : LANDMARK_TAGS[tag];
    if (implied) return { role: implied, name: accName(el).slice(0, 80) };
    return null;
  }
  function landmarkPath(el) {
    // Closest-first walk up to <body>, collecting landmark ancestors.
    // Reversed at the end so root-most landmark is first.
    const out = [];
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const info = landmarkInfo(p);
      if (info) out.push(info);
      p = p.parentElement;
    }
    return out.reverse();
  }
  const refs = []; let i = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    i += 1;
    const r = {
      id: 'e' + i,
      selector: cssPath(el),
      role: role(el),
      name: accName(el).slice(0, 120),
      tag: el.tagName.toLowerCase(),
      path: landmarkPath(el),
    };
    if (el.tagName === 'A' && el.getAttribute('href')) r.href = el.getAttribute('href');
    if ('value' in el && el.value) r.value = String(el.value).slice(0, 120);
    refs.push(r);
  }
  return { url: location.href, title: document.title, refs };
})()`;

// Bare expressions, not IIFEs: they take no input, so there is nothing to
// quote. Named here so this file really is every string bowser evaluates in
// the page, which is what the layer rule and CLAUDE.md claim.
export const READ_URL = "location.href";
export const READ_TITLE = "document.title";
export const HISTORY_BACK = "history.back()";
export const HISTORY_FORWARD = "history.forward()";
export const RELOAD = "location.reload()";

export function hoverScript(selector: string): string {
  return `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('hover: element not found');
        const r = el.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      })()`;
}

export function selectScript(selector: string, value: string): string {
  return `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('select: element not found');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`;
}

export function setCheckedScript(selector: string, checked: boolean): string {
  return `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('check: element not found');
        if (Boolean(el.checked) !== ${checked}) el.click();
      })()`;
}

export function clearForFillScript(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`;
}

export type StorageArea = "localStorage" | "sessionStorage";

// Wraps a body in a try/catch so a SecurityError (e.g. on `about:blank` or
// pages where storage is disabled) surfaces as a readable daemon error rather
// than a bare DOMException.
export function storageScript(area: StorageArea, body: string): string {
  return `(() => { try { ${body} } catch (e) { throw new Error('${area}: ' + (e && e.message || e)); } })()`;
}

export function storageListScript(area: StorageArea): string {
  return storageScript(area, `const o = {}; for (let i = 0; i < ${area}.length; i++) { const k = ${area}.key(i); o[k] = ${area}.getItem(k); } return o;`);
}

export function storageGetScript(area: StorageArea, key: string): string {
  return storageScript(area, `return ${area}.getItem(${JSON.stringify(key)});`);
}

export function storageSetScript(area: StorageArea, key: string, value: string): string {
  return storageScript(area, `${area}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
}

export function storageDeleteScript(area: StorageArea, key: string): string {
  return storageScript(area, `${area}.removeItem(${JSON.stringify(key)});`);
}

export function storageClearScript(area: StorageArea): string {
  return storageScript(area, `${area}.clear();`);
}

export function storageRestoreScript(
  area: StorageArea,
  entries: Array<{ name: string; value: string }>,
): string {
  return storageScript(
    area,
    entries.map((e) => `${area}.setItem(${JSON.stringify(e.name)}, ${JSON.stringify(e.value)});`).join(" "),
  );
}

export function runCodeScript(code: string): string {
  return `(() => { ${code} })()`;
}
