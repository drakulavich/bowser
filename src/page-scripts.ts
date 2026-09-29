// Every JavaScript snippet bowser injects into the page. Builders take user
// input (selectors, keys, values) and embed it with JSON.stringify, which is
// what keeps a selector with quotes from breaking out of the string. This
// file imports nothing from src/ and is the only one allowed to build an
// IIFE string (tests/layers.test.ts).

// cssPath(el): a unique id, else an nth-of-type chain from <html>. The
// selector an action on a ref uses, computed in the live page by
// resolveRefScript; a ref saves none. Chains and sibling indexes are memoized
// per evaluation. Plain JavaScript under String.raw: no backticks, no
// dollar-brace.
const CSS_PATH = String.raw`
  const chains = new Map();
  const nthIndex = new Map();
  function nthOfType(el) {
    if (!nthIndex.has(el)) {
      const counts = {};
      for (const c of el.parentElement.children) {
        counts[c.tagName] = (counts[c.tagName] || 0) + 1;
        nthIndex.set(c, counts[c.tagName]);
      }
    }
    return nthIndex.get(el);
  }
  function chain(el) {
    let s = chains.get(el);
    if (s === undefined) {
      const parent = el.parentElement;
      s = el.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(el) + ')';
      if (parent !== document.documentElement) s = chain(parent) + ' > ' + s;
      chains.set(el, s);
    }
    return s;
  }
  function cssPath(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const byId = document.querySelectorAll('#' + el.id);
      if (byId.length === 1) return '#' + el.id;
    }
    return 'html > ' + chain(el);
  }`;

// The rule behind the snapshot's [disabled], inlined into SNAPSHOT_SCRIPT and
// resolveRefScript so `click`/`check`/`uncheck` refuse exactly what the
// snapshot marks (spec F20): a natively disabled control (a disabled
// <fieldset> included, except in its first legend), or aria-disabled="true"
// on the element or an ancestor, for the roles that take it. The scope must
// define tagOf(el) and ariaRole(el); ariaRole is asked only of the element
// itself, never of an ancestor. Plain JavaScript under String.raw.
const DISABLED = String.raw`
  const DISABLED_ROLES = ['application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem',
    'scrollbar', 'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox', 'select',
    'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem'];
  const inDisabledFieldset = (el) => {
    const fs = el.closest('fieldset[disabled]');
    if (!fs) return false;
    const legend = fs.querySelector(':scope > legend');
    return !legend || !legend.contains(el);
  };
  const nativelyDisabled = (el) => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(tagOf(el)) &&
    (el.hasAttribute('disabled') || (tagOf(el) === 'OPTION' && !!el.closest('optgroup[disabled]')) || inDisabledFieldset(el));
  function ariaDisabled(el, ancestor) {
    if (!el) return false;
    if (!ancestor && nativelyDisabled(el)) return true;
    if (ancestor || DISABLED_ROLES.includes(ariaRole(el) || '')) {
      const a = (el.getAttribute('aria-disabled') || '').toLowerCase();
      if (a === 'true') return true;
      if (a === 'false') return false;
      return ariaDisabled(el.parentElement, true);
    }
    return false;
  }
  const isDisabled = (el, role) => DISABLED_ROLES.includes(role) && ariaDisabled(el, false);`;

// The snapshot walker, serialized into the page. It builds the aria tree from
// document.body the way playwright-cli 0.1.x does (its injected script's
// generateAriaTree, trimmed to what bowser prints: no iframes' contents, no
// shadow DOM, no aria-owns) and returns SnapshotResult (src/snapshot.ts).
// Written with String.raw, so backslashes below are plain JavaScript; the
// only things this text may not contain are backticks and dollar-brace,
// apart from the two interpolations, DISABLED and CSS_PATH.
//
// Refs: every visible node that receives pointer events gets `e<N>`, in DOM
// pre-order. The element -> {ref, role, name} map, the reverse ref ->
// WeakRef(element) map and the counter live on window, so a ref survives
// between snapshots of one document while the element's role and name are
// unchanged, and a new document starts at e1. Each ref is saved with its
// CSS_PATH; an action resolves the ref through the reverse map first
// (resolveRefScript) and uses a path computed at that moment.
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const KEY = Symbol.for('bowser.aria-refs');
  const store = window[KEY] || (window[KEY] = { refs: new WeakMap(), byRef: new Map(), last: 0 });
  // A store from a previous bowser version has no byRef.
  if (!store.byRef) store.byRef = new Map();
  // Forget refs whose element is gone, so byRef does not grow with every re-render.
  for (const [ref, w] of store.byRef) if (!w.deref()?.isConnected) store.byRef.delete(ref);

  const styleCache = new Map();
  const styleOf = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };
  const norm = (s) => s.replace(/[​­]/g, '').trim().replace(/\s+/g, ' ');
  const tagOf = (el) => el.tagName.toUpperCase();
  // A password field's value never leaves the page: no value child, no saved
  // ref value, no part of any accessible name. Deliberately unlike playwright-cli.
  const isPassword = (el) => tagOf(el) === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
  // The walker's only read of an element's value (tests/page-scripts.test.ts).
  const valueOf = (el) => isPassword(el) ? '' : el.value;

  // ---- roles (html-aam implicit roles, as Playwright computes them) ----
  const VALID_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure ' +
    'form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter ' +
    'menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar ' +
    'radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong ' +
    'subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem').split(' '));
  const TAG_ROLES = {
    ARTICLE: 'article', ASIDE: 'complementary', BLOCKQUOTE: 'blockquote', BUTTON: 'button', CAPTION: 'caption',
    CODE: 'code', DATALIST: 'listbox', DD: 'definition', DEL: 'deletion', DETAILS: 'group', DFN: 'term',
    DIALOG: 'dialog', DT: 'term', EM: 'emphasis', FIELDSET: 'group', FIGURE: 'figure', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', HR: 'separator', HTML: 'document', INS: 'insertion',
    LI: 'listitem', MAIN: 'main', MARK: 'mark', MATH: 'math', MENU: 'list', METER: 'meter', NAV: 'navigation',
    OL: 'list', OPTGROUP: 'group', OPTION: 'option', OUTPUT: 'status', P: 'paragraph', PROGRESS: 'progressbar',
    SEARCH: 'search', STRONG: 'strong', SUB: 'subscript', SUP: 'superscript', SVG: 'img', TABLE: 'table',
    TBODY: 'rowgroup', TEXTAREA: 'textbox', TFOOT: 'rowgroup', THEAD: 'rowgroup', TIME: 'time', TR: 'row', UL: 'list',
  };
  const INPUT_ROLES = { button: 'button', checkbox: 'checkbox', file: 'button', image: 'button', number: 'spinbutton',
    radio: 'radio', range: 'slider', reset: 'button', submit: 'button' };
  const LANDMARK_BLOCKERS = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), ' +
    'section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';
  const GLOBAL_ARIA = ['aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-details',
    'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-hidden', 'aria-keyshortcuts', 'aria-label',
    'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription'];
  const NO_NAME_ROLES = ['caption', 'code', 'definition', 'deletion', 'emphasis', 'generic', 'insertion', 'mark',
    'paragraph', 'presentation', 'strong', 'subscript', 'suggestion', 'superscript', 'term', 'time'];
  const PRESENTATION_PARENTS = { DD: ['DL', 'DIV'], DIV: ['DL'], DT: ['DL', 'DIV'], LI: ['OL', 'UL'], TBODY: ['TABLE'],
    TD: ['TR'], TFOOT: ['TABLE'], TH: ['TR'], THEAD: ['TABLE'], TR: ['THEAD', 'TBODY', 'TFOOT', 'TABLE'] };

  const hasLabel = (el) => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
  const hasTabIndex = (el) => !Number.isNaN(Number(String(el.getAttribute('tabindex'))));
  const hasGlobalAria = (el, role) => GLOBAL_ARIA.some((a) => el.hasAttribute(a) &&
    !((a === 'aria-label' || a === 'aria-labelledby') && ['caption', 'code', 'deletion', 'emphasis', 'generic',
      'insertion', 'paragraph', 'presentation', 'strong', 'subscript', 'superscript'].includes(role)) &&
    !(a === 'aria-roledescription' && role === 'generic'));
  ${DISABLED}
  const focusable = (el) => {
    if (nativelyDisabled(el)) return false;
    const t = tagOf(el);
    if (['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA'].includes(t)) return true;
    if (t === 'A' || t === 'AREA') return el.hasAttribute('href') || hasTabIndex(el);
    if (t === 'INPUT') return !el.hidden || hasTabIndex(el);
    return hasTabIndex(el);
  };
  const explicitRole = (el) => (el.getAttribute('role') || '').split(' ').map((r) => r.trim()).find((r) => VALID_ROLES.has(r)) || null;

  function tagRole(el) {
    const t = tagOf(el);
    if (TAG_ROLES[t]) return TAG_ROLES[t];
    switch (t) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
      case 'FOOTER': return el.closest(LANDMARK_BLOCKERS) ? null : 'contentinfo';
      case 'HEADER': return el.closest(LANDMARK_BLOCKERS) ? null : 'banner';
      case 'FORM': return hasLabel(el) ? 'form' : null;
      case 'SECTION': return hasLabel(el) ? 'region' : null;
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'IMG':
        return el.getAttribute('alt') === '' && !el.getAttribute('title') && !hasGlobalAria(el) && !hasTabIndex(el)
          ? 'presentation' : 'img';
      case 'INPUT': {
        const type = el.type.toLowerCase();
        if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['email', 'tel', 'text', 'url', ''].includes(type)) {
          return el.list && tagOf(el.list) === 'DATALIST' ? 'combobox' : 'textbox';
        }
        if (type === 'hidden') return null;
        return INPUT_ROLES[type] || 'textbox';
      }
      case 'TD': {
        const table = el.closest('table');
        const r = table ? explicitRole(table) : null;
        return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell';
      }
      case 'TH': {
        const scope = el.getAttribute('scope');
        if (scope === 'col' || scope === 'colgroup') return 'columnheader';
        if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
        const next = el.nextElementSibling, prev = el.previousElementSibling;
        if (!next && !prev) {
          const row = el.parentElement && tagOf(el.parentElement) === 'TR' ? el.parentElement : null;
          const table = row && row.closest('table');
          return table && table.rows.length <= 1 ? null : 'columnheader';
        }
        const isTh = (x) => !!x && tagOf(x) === 'TH';
        const isData = (x) => !!x && tagOf(x) === 'TD' && !!((x.textContent || '').trim() || x.children.length);
        if (isTh(next) && isTh(prev)) return 'columnheader';
        return isData(next) || isData(prev) ? 'rowheader' : 'columnheader';
      }
    }
    return null;
  }
  function implicitRole(el) {
    const role = tagRole(el);
    if (!role) return null;
    // A list item or table part under role=none/presentation inherits it.
    for (let a = el; a; a = a.parentElement) {
      const parent = a.parentElement;
      const parents = PRESENTATION_PARENTS[tagOf(a)];
      if (!parents || !parent || !parents.includes(tagOf(parent))) break;
      const pr = explicitRole(parent);
      if ((pr === 'none' || pr === 'presentation') && !hasGlobalAria(parent, pr) && !focusable(parent)) return pr;
    }
    return role;
  }
  const roleCache = new Map();
  function ariaRole(el) {
    if (roleCache.has(el)) return roleCache.get(el);
    let role = explicitRole(el);
    if (!role) role = implicitRole(el);
    else if (role === 'none' || role === 'presentation') {
      const im = implicitRole(el);
      if (hasGlobalAria(el, im) || focusable(el)) role = im;
    }
    roleCache.set(el, role);
    return role;
  }

  // ---- visibility ----
  const IGNORED_TAGS = ['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'];
  // Not rendered or hidden from the accessibility tree, with the whole subtree.
  const hiddenSubtree = (el) => IGNORED_TAGS.includes(tagOf(el)) || styleOf(el).display === 'none' ||
    (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
  // Hidden itself, though a descendant may be visible again (visibility).
  function styleHidden(el) {
    const ds = el.closest('details,summary');
    if (ds && ds !== el && tagOf(ds) === 'DETAILS' && !ds.open) return true;
    if (tagOf(el) === 'OPTION' && el.closest('select')) return false;
    return styleOf(el).visibility !== 'visible';
  }
  const textVisible = (node) => {
    const range = document.createRange();
    range.selectNode(node);
    const r = range.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  function box(el) {
    const s = styleOf(el);
    const cursor = s.cursor;
    if (s.display === 'contents') {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && box(c).visible) return { visible: true, inline: false, cursor };
        if (c.nodeType === 3 && textVisible(c)) return { visible: true, inline: true, cursor };
      }
      return { visible: false, inline: false, cursor };
    }
    if (styleHidden(el)) return { visible: false, inline: false, cursor };
    const r = el.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0, inline: s.display === 'inline', cursor };
  }

  // ---- CSS generated content ----
  function cssContent(el, pseudo) {
    const s = getComputedStyle(el, pseudo);
    const c = s && s.content;
    if (!c || c === 'none' || c === 'normal' || s.display === 'none' || s.visibility === 'hidden') return '';
    const tokens = c.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|attr\(\s*[\w-]+\s*\)|\/|[^\s"'\/]+/g) || [];
    const slash = tokens.indexOf('/');
    let text = '';
    for (const t of slash >= 0 ? tokens.slice(slash + 1) : tokens) {
      if (t[0] === '"' || t[0] === "'") text += t.slice(1, -1).replace(/\\(.)/g, '$1');
      else if (t.startsWith('attr(')) text += el.getAttribute(t.slice(5, -1).trim()) || '';
      else return '';
    }
    return (s.display || 'inline') !== 'inline' ? ' ' + text + ' ' : text;
  }

  // ---- accessible name (accname, as Playwright's getElementAccessibleName) ----
  const CONTENT_ROLES = ['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem'];
  const DESCENDANT_CONTENT_ROLES = ['', 'caption', 'code', 'contentinfo', 'definition', 'deletion', 'emphasis',
    'insertion', 'list', 'listitem', 'mark', 'none', 'paragraph', 'presentation', 'region', 'row', 'rowgroup',
    'section', 'strong', 'subscript', 'superscript', 'table', 'term', 'time'];
  const nameHidden = (el) => hiddenSubtree(el) || styleHidden(el);
  const idRefs = (el, attr) => {
    const ids = (el.getAttribute(attr) || '').split(' ').filter(Boolean);
    const out = [];
    for (const id of ids) {
      const found = document.getElementById(id);
      if (found && !out.includes(found)) out.push(found);
    }
    return out.length ? out : null;
  };
  const fromLabels = (labels, o) => [...labels]
    .map((l) => textAlt(l, { visited: o.visited, embedded: true, hiddenOk: nameHidden(l) }))
    .filter(Boolean).join(' ');
  const firstChildTagged = (el, tag) => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (tagOf(c) === tag) return c;
    return null;
  };

  // o: { visited: Set, mode: 'self' | 'descendant' | undefined, embedded: bool, labelledBy: bool, hiddenOk: bool }
  function textAlt(el, o) {
    if (o.visited.has(el)) return '';
    const child = Object.assign({}, o, { mode: o.mode === 'self' ? 'descendant' : o.mode });
    if (!o.hiddenOk && nameHidden(el)) { o.visited.add(el); return ''; }
    const labelledBy = el.hasAttribute('aria-labelledby') ? idRefs(el, 'aria-labelledby') : null;
    if (!o.labelledBy && labelledBy) {
      const s = labelledBy.map((r) => textAlt(r, { visited: o.visited, embedded: true, labelledBy: true, hiddenOk: nameHidden(r) })).join(' ');
      if (s) return s;
    }
    const role = ariaRole(el) || '';
    const tag = tagOf(el);
    if (o.embedded || o.mode === 'descendant') {
      if (role === 'textbox') {
        o.visited.add(el);
        return tag === 'INPUT' || tag === 'TEXTAREA' ? valueOf(el) : (el.textContent || '');
      }
      if (role === 'combobox' || role === 'listbox') {
        o.visited.add(el);
        if (tag === 'SELECT') {
          let selected = [...el.selectedOptions];
          if (!selected.length && el.options.length) selected = [el.options[0]];
          return selected.map((x) => textAlt(x, child)).join(' ');
        }
        return tag === 'INPUT' ? valueOf(el) : '';
      }
      if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
        o.visited.add(el);
        const v = el.getAttribute('aria-valuetext');
        if (v !== null) return v;
        const n = el.getAttribute('aria-valuenow');
        return n !== null ? n : (isPassword(el) ? '' : (el.getAttribute('value') || ''));
      }
      if (role === 'menu') { o.visited.add(el); return ''; }
    }
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) { o.visited.add(el); return ariaLabel; }
    if (role !== 'presentation' && role !== 'none') {
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
        o.visited.add(el);
        const v = valueOf(el) || '';
        if (v.trim()) return v;
        if (el.type === 'submit') return 'Submit';
        if (el.type === 'reset') return 'Reset';
        return el.getAttribute('title') || '';
      }
      if (tag === 'INPUT' && (el.type === 'file' || el.type === 'image')) {
        o.visited.add(el);
        if (el.labels && el.labels.length && !o.labelledBy) return fromLabels(el.labels, o);
        if (el.type === 'file') return 'Choose File';
        return (el.getAttribute('alt') || '').trim() ? el.getAttribute('alt') :
          (el.getAttribute('title') || '').trim() ? el.getAttribute('title') : 'Submit';
      }
      if (!labelledBy && (tag === 'BUTTON' || tag === 'OUTPUT')) {
        o.visited.add(el);
        if (el.labels && el.labels.length) return fromLabels(el.labels, o);
        if (tag === 'OUTPUT') return el.getAttribute('title') || '';
      }
      if (!labelledBy && (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT')) {
        o.visited.add(el);
        if (el.labels && el.labels.length) return fromLabels(el.labels, o);
        const usePlaceholder = (tag === 'INPUT' && ['text', 'password', 'search', 'tel', 'email', 'url'].includes(el.type)) || tag === 'TEXTAREA';
        const title = el.getAttribute('title') || '';
        return !usePlaceholder || title ? title : (el.getAttribute('placeholder') || '');
      }
      const caption = !labelledBy && tag === 'FIELDSET' ? 'LEGEND' : !labelledBy && tag === 'FIGURE' ? 'FIGCAPTION' : tag === 'TABLE' ? 'CAPTION' : '';
      if (caption) {
        o.visited.add(el);
        const c = firstChildTagged(el, caption);
        if (c) return textAlt(c, Object.assign({}, child, { embedded: true, hiddenOk: nameHidden(c) }));
        if (tag === 'TABLE') { if (el.getAttribute('summary')) return el.getAttribute('summary'); }
        else return el.getAttribute('title') || '';
      }
      if (tag === 'IMG' || tag === 'AREA') {
        o.visited.add(el);
        const alt = el.getAttribute('alt') || '';
        return alt.trim() ? alt : (el.getAttribute('title') || '');
      }
      // An <svg>, or an element inside one, is named by its first child SVG
      // <title>, read like an aria-labelledby target (playwright's rule).
      if (tag === 'SVG' || el.ownerSVGElement) {
        o.visited.add(el);
        for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
          if (tagOf(c) === 'TITLE' && c.ownerSVGElement) {
            return textAlt(c, Object.assign({}, child, { embedded: true, labelledBy: true, hiddenOk: nameHidden(c) }));
          }
        }
      }
    }
    const summary = tag === 'SUMMARY' && role !== 'presentation' && role !== 'none';
    if (CONTENT_ROLES.includes(role) || (o.mode === 'descendant' && DESCENDANT_CONTENT_ROLES.includes(role)) || summary || o.embedded) {
      o.visited.add(el);
      const s = innerText(el, child);
      if (o.mode === 'self' ? s.trim() : s) return s;
    }
    o.visited.add(el);
    if (role !== 'presentation' && role !== 'none' || tag === 'IFRAME') {
      const title = el.getAttribute('title') || '';
      if (title.trim()) return title;
    }
    return '';
  }
  function innerText(el, o) {
    const parts = [cssContent(el, '::before')];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        const t = textAlt(c, o);
        parts.push((styleOf(c).display || 'inline') !== 'inline' || c.nodeName === 'BR' ? ' ' + t + ' ' : t);
      } else if (c.nodeType === 3) {
        parts.push(c.textContent || '');
      }
    }
    parts.push(cssContent(el, '::after'));
    return parts.join('');
  }
  function nameOf(el) {
    if (NO_NAME_ROLES.includes(ariaRole(el) || '')) return '';
    const name = norm(textAlt(el, { visited: new Set(), mode: 'self' }));
    return name.length > 900 ? '' : name;
  }

  // ---- state attributes ----
  const CHECKED_ROLES = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
  const EXPANDED_ROLES = ['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
    'row', 'rowheader', 'tab', 'treeitem', 'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch'];
  const LEVEL_ROLES = ['heading', 'listitem', 'row', 'treeitem'];
  const SELECTED_ROLES = ['cell', 'gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
  const HEADING_LEVELS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

  function addState(n, el) {
    const role = n.role, tag = tagOf(el);
    if (CHECKED_ROLES.includes(role)) {
      let c = false;
      if (tag === 'INPUT' && el.indeterminate) c = 'mixed';
      else if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) c = el.checked;
      else c = el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : false;
      if (c) n.checked = c;
    }
    if (isDisabled(el, role)) n.disabled = true;
    if ((EXPANDED_ROLES.includes(role) && el.getAttribute('aria-expanded') === 'true') ||
      (tag === 'SUMMARY' && el.parentElement && tagOf(el.parentElement) === 'DETAILS' && el.parentElement.open)) n.expanded = true;
    if (el === document.activeElement) n.active = true;
    let level = HEADING_LEVELS[tag] || 0;
    if (!level && LEVEL_ROLES.includes(role)) {
      const v = Number(el.getAttribute('aria-level') === null ? NaN : el.getAttribute('aria-level'));
      if (Number.isInteger(v) && v >= 1) level = v;
    }
    if (level) n.level = level;
    if (role === 'button') {
      const p = el.getAttribute('aria-pressed');
      if (p === 'true') n.pressed = true;
      else if (p === 'mixed') n.pressed = 'mixed';
    }
    if (tag === 'OPTION' ? el.selected : SELECTED_ROLES.includes(role) && el.getAttribute('aria-selected') === 'true') n.selected = true;
  }

  // ---- refs ----
  const refs = [];
  function assignRef(n, el) {
    let r = store.refs.get(el);
    if (!r || r.role !== n.role || r.name !== n.name) {
      r = { ref: 'e' + (++store.last), role: n.role, name: n.name };
      store.refs.set(el, r);
    }
    store.byRef.set(r.ref, new WeakRef(el));
    n.ref = r.ref;
    const saved = { id: r.ref, role: n.role, name: n.name, tag: el.tagName.toLowerCase() };
    if (tagOf(el) === 'A' && el.getAttribute('href')) saved.href = el.getAttribute('href');
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagOf(el)) && valueOf(el)) saved.value = String(valueOf(el)).slice(0, 120);
    if (el.isContentEditable) saved.editable = true;
    refs.push(saved);
  }

  // ---- the walk ----
  const cursorOf = new Map();   // node -> computed cursor, for the cursor pass
  function toNode(el) {
    if (tagOf(el) === 'IFRAME') {
      const n = { role: 'iframe', name: '', children: [] };
      // Playwright hard-codes pointer events on for iframes; spec 3.6 does not.
      if (box(el).visible && styleOf(el).pointerEvents !== 'none') assignRef(n, el);
      if (el === document.activeElement) n.active = true;
      cursorOf.set(n, styleOf(el).cursor);
      return n;
    }
    const role = ariaRole(el) || 'generic';
    if (role === 'presentation' || role === 'none') return null;
    const b = box(el);
    // An inline generic holding only text is not a node: its text flows into the parent.
    if (role === 'generic' && b.inline && el.childNodes.length === 1 && el.firstChild.nodeType === 3) return null;
    const n = { role, name: nameOf(el), children: [] };
    if (b.visible && styleOf(el).pointerEvents !== 'none') assignRef(n, el);
    addState(n, el);
    cursorOf.set(n, b.cursor);
    if ((tagOf(el) === 'INPUT' && !['checkbox', 'radio', 'file'].includes(el.type) && !isPassword(el)) || tagOf(el) === 'TEXTAREA') {
      n.children.push(valueOf(el));
    }
    return n;
  }
  function visit(parent, node, parentVisible) {
    if (node.nodeType === 3) {
      if (parentVisible && node.nodeValue && parent.role !== 'textbox') parent.children.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1 || hiddenSubtree(node)) return;
    const visible = !styleHidden(node) || styleOf(node).display === 'contents';
    const n = visible ? toNode(node) : null;
    if (n) parent.children.push(n);
    const target = n || parent;
    const block = (styleOf(node).display || 'inline') !== 'inline' || node.nodeName === 'BR';
    if (block) target.children.push(' ');
    target.children.push(cssContent(node, '::before'));
    if (tagOf(node) !== 'IFRAME') {
      for (let c = node.firstChild; c; c = c.nextSibling) visit(target, c, visible);
    }
    target.children.push(cssContent(node, '::after'));
    if (block) target.children.push(' ');
    if (target.children.length === 1 && target.name === target.children[0]) target.children = [];
    if (target.role === 'link' && node.hasAttribute('href')) {
      target.props = Object.assign(target.props || {}, { url: node.getAttribute('href') });
    }
    if (target.role === 'textbox' && node.hasAttribute('placeholder') && node.getAttribute('placeholder') !== target.name) {
      target.props = Object.assign(target.props || {}, { placeholder: node.getAttribute('placeholder') });
    }
  }
  // Merge adjacent text runs into one normalized line; drop text equal to the name.
  function mergeText(n) {
    const out = [];
    let buf = [];
    const flush = () => {
      const t = norm(buf.join(''));
      if (t) out.push(t);
      buf = [];
    };
    for (const c of n.children) {
      if (typeof c === 'string') { buf.push(c); continue; }
      flush();
      mergeText(c);
      out.push(c);
    }
    flush();
    n.children = out.length === 1 && out[0] === n.name ? [] : out;
  }
  // Bottom-up: an unnamed generic with at most one child, a ref-bearing node, is replaced by it.
  function collapse(n) {
    const out = [];
    for (const c of n.children) {
      if (typeof c === 'string') out.push(c);
      else out.push(...collapse(c));
    }
    if (n.role === 'generic' && !n.name && out.length <= 1 && out.every((c) => typeof c !== 'string' && c.ref)) return out;
    n.children = out;
    return [n];
  }
  // [cursor=pointer] only on ref-bearing nodes, and not under a node that already printed it.
  function markCursor(n, allowed) {
    const own = allowed && !!n.ref && cursorOf.get(n) === 'pointer';
    if (own) n.cursor = true;
    for (const c of n.children) if (typeof c !== 'string') markCursor(c, allowed && !own);
  }

  const root = { role: 'fragment', name: '', children: [] };
  if (document.body) visit(root, document.body, true);
  mergeText(root);
  collapse(root);
  for (const c of root.children) if (typeof c !== 'string') markCursor(c, true);
  return { url: location.href, title: document.title, tree: root.children, refs };
})()`;

// The WebKit dialog shim (dialogs spec, item 5). WebKit has no dialog events:
// its engine dismisses every dialog itself and tells nobody. So the daemon
// replaces window.alert/confirm/prompt with functions that answer at once:
// the one-shot answer if set, then cleared, else dismissed; an accepted prompt with no text gets its
// default. Each answer is logged as a DialogReport for the daemon to read.
// Only the engine's own functions are replaced (their source says
// [native code]): a page that defined its own keeps it (P1 F24). Every
// same-origin child frame reachable through window.frames gets the shim too,
// sharing the top window's answer and log (P1 F25); a cross-origin frame
// throws on access and is skipped. A frame is walked on every evaluation, so
// one that loaded since the last op gets the shim then.
// The shim, its answer and its log live on window, so a new document has
// none. A document the back-forward cache restores keeps its shim, so the
// answer is also dropped twice over: by the page on pagehide, and by `drop`
// when the daemon saw a navigation or ran a navigating op. The expression evaluates to
// the shim. No backticks or dollar-brace below, apart from the interpolation.
function dialogShim(drop: boolean): string {
  return String.raw`(() => {
  const KEY = Symbol.for('bowser.dialogs');
  let shim = window[KEY];
  const fresh = !shim;
  if (fresh) {
    shim = { answer: null, log: [] };
    Object.defineProperty(window, KEY, { value: shim });
    // Leaving the document (a link, a form, history.back() in a handler)
    // drops the answer, so a cached copy of it comes back without one.
    window.addEventListener('pagehide', () => { shim.answer = null; });
  }
  const str = (v) => v === undefined ? '' : String(v);
  const answer = (type, message, defaultValue) => {
    const given = shim.answer;
    shim.answer = null;
    const accept = given ? given.accept : false;
    const d = { type, message: str(message) };
    if (type === 'prompt') d.defaultValue = str(defaultValue);
    d.state = accept ? 'accepted' : 'dismissed';
    let reply = accept;
    if (type === 'prompt') {
      reply = accept ? (typeof given.text === 'string' ? given.text : d.defaultValue) : null;
      if (accept) d.answer = reply;
    }
    if (!given) d.unanswered = true;
    shim.log.push(d);
    return reply;
  };
  const native = (fn) => {
    try { return /\[native code\]/.test(Function.prototype.toString.call(fn)); } catch (e) { return false; }
  };
  const install = (w) => {
    if (w !== window) Object.defineProperty(w, KEY, { value: shim });
    if (native(w.alert)) w.alert = function alert(message) { answer('alert', message); };
    if (native(w.confirm)) w.confirm = function confirm(message) { return answer('confirm', message); };
    if (native(w.prompt)) w.prompt = function prompt(message, defaultValue) { return answer('prompt', message, defaultValue); };
  };
  if (fresh) install(window);
  const walk = (w) => {
    for (let i = 0; i < w.length; i++) {
      try {
        const f = w[i];
        if (!f[KEY]) install(f);
        walk(f);
      } catch (e) {}
    }
  };
  walk(window);
  if (${JSON.stringify(drop)}) shim.answer = null;
  return shim;
})()`;
}

// The page's answer as JSON text, built in the page (#76). Bun.WebView
// serializes an evaluate's value with the page's own JSON, so a toJSON the
// page put on Object.prototype or Array.prototype (Prototype.js sets
// Array's) rewrote every object or array bowser read back: the snapshot, a
// dialog log, an eval result. The standard defines neither, so both are set
// aside for this one synchronous call and put back; the answer then crosses
// as a string, which no toJSON touches. A value's own toJSON, a class's
// (Date, URL) and any toJSON the user's own expression calls still apply.
// The server parses the text (fromPage in src/daemon/server.ts).
const PAGE_JSON = String.raw`((v) => {
  const O = Object.prototype, A = Array.prototype, own = Object.getOwnPropertyDescriptor;
  // A toJSON that cannot be deleted cannot be set aside: refuse rather than
  // answer the page's text as the result. (A replaced JSON.stringify is
  // refused for every evaluate, by readable().)
  const o = own(O, 'toJSON'), a = own(A, 'toJSON');
  if (o) delete O.toJSON;
  if (a) delete A.toJSON;
  try {
    if (own(O, 'toJSON') || own(A, 'toJSON')) {
      throw new Error("bowser cannot read this page: it locked Object.prototype.toJSON or Array.prototype.toJSON");
    }
    return JSON.stringify(v);
  } finally {
    if (o && !own(O, 'toJSON')) Object.defineProperty(O, 'toJSON', o);
    if (a && !own(A, 'toJSON')) Object.defineProperty(A, 'toJSON', a);
  }
})`;

/** `expr`, refused when the page has replaced JSON.stringify. WebKit
 *  returns every evaluate's value through the page's JSON.stringify, so a
 *  replaced one answers the page's text as bowser's result: `open` printed
 *  the page's string as its URL and title (#84 review). The check itself
 *  uses the page's Function.prototype.toString, so a page that forges it
 *  passes. That is deliberate: bowser shields against legacy libraries'
 *  patches, not against a page written to deceive automation, which no
 *  check made from inside the page can stop. */
export function readable(expr: string): string {
  return `(() => {
  if (!/\\[native code\\]/.test(Function.prototype.toString.call(JSON.stringify))) {
    throw new Error("bowser cannot read this page: it replaced JSON.stringify");
  }
  return (
${expr}
);
})()`;
}

/** `expr` evaluated with the dialog shim installed first. Evaluates to
 *  `{ value, dialogs }` as PAGE_JSON text: expr's value, and the shim's log
 *  read after it settles. Newlines around `expr` keep a trailing line
 *  comment in it. */
export function withDialogShim(expr: string, drop: boolean): string {
  return `(async () => {
  const shim = ${dialogShim(drop)};
  const value = await (
${expr}
);
  return ${PAGE_JSON}({ value, dialogs: shim.log.splice(0) });
})()`;
}

/** Install the dialog shim if this document lacks it; read and clear its
 *  log, as PAGE_JSON text. */
export function dialogSyncScript(drop: boolean): string {
  return `${PAGE_JSON}(${dialogShim(drop)}.log.splice(0))`;
}

/** Set the shim's one-shot answer (installing it first); read and clear its
 *  log, as PAGE_JSON text. */
export function dialogAnswerScript(answer: { accept: boolean; text?: string }): string {
  return `(() => {
  const shim = ${dialogShim(false)};
  shim.answer = ${JSON.stringify(answer)};
  return ${PAGE_JSON}(shim.log.splice(0));
})()`;
}

// Bare expressions, not IIFEs: they take no input, so there is nothing to
// quote. Named here so this file really is every string bowser evaluates in
// the page, which is what the layer rule claims.
export const READ_URL = "location.href";
export const READ_TITLE = "document.title";
export const RELOAD = "location.reload()";
/** The viewport in CSS pixels and the pixel ratio: what a failed
 *  screenshot checks against WebKit's capture limit (#69). */
export const READ_VIEWPORT = "[innerWidth, innerHeight, devicePixelRatio]";
/** Recovery before the first commit (#48): the initial empty document
 *  leaves itself, which cancels a navigation stuck there. */
export const LEAVE_INITIAL_DOCUMENT = "location.replace('about:blank')";
/** Recovery when reload() is refused because a page navigation is pending
 *  (#78): reloading by script cancels it. */
export const CANCEL_PENDING_NAVIGATION = "location.replace(location.href)";
/** Evaluated in browser.ts's kicker view, never in the page (oven-sh/bun#44134). */
export const NO_OP = "0";

// The navigation watch's page side (browser.ts, nav.act). On WebKit a
// navigation the page starts (a link, a form submit, a script setting
// location) shows neither in view.loading nor in onNavigated until the
// server answers; the Navigation API's navigate event fires within ~6 ms
// (measured, Bun 1.4.2). NAV_ARM listens for it once per document and
// zeroes the count before each action; NAV_COUNT reads how many
// cross-document navigations the page has started since, and NAV_DESTINATION
// where the last one goes. A same-document
// navigation (a hash link) never lands, so it is not counted.
// The API is reached only as `window.navigation`: a page's own global
// `let navigation` shadows the bare name in any script run there. A missing
// or broken API leaves the count at 0, which reads as "no navigation".
export const NAV_ARM = String.raw`(() => {
  const KEY = Symbol.for('bowser.nav');
  let s = window[KEY];
  if (!s) {
    s = { count: 0 };
    Object.defineProperty(window, KEY, { value: s });
    try {
      const api = window.navigation;
      if (api && typeof api.addEventListener === 'function') {
        api.addEventListener('navigate', (e) => { if (!e.destination.sameDocument) { s.count++; s.url = e.destination.url; } });
      }
    } catch {}
  }
  s.count = 0;
})()`;
export const NAV_COUNT = "window[Symbol.for('bowser.nav')]?.count ?? 0";
export const NAV_DESTINATION = "window[Symbol.for('bowser.nav')]?.url";

// `press Meta+a` and friends (#55). Bun.WebView sends Meta+A/Z to WebKit as
// key events only; on macOS those shortcuts are menu commands, which the page
// never gets (measured, Bun 1.4.2). KEY_WATCH keeps the next keydown, seen
// first in the capture phase; keyCommandScript then runs the editing command
// the menu would, unless a page handler cancelled that keydown. It is the
// same table and the same cancel rule as Playwright's WebKit on macOS.
export const KEY_WATCH = String.raw`(() => {
  const KEY = Symbol.for('bowser.key');
  window[KEY] = null;
  addEventListener('keydown', (e) => { window[KEY] = e; }, { capture: true, once: true });
})()`;

export function keyCommandScript(command: "selectAll" | "undo" | "redo"): string {
  return `(() => {
  const KEY = Symbol.for('bowser.key');
  const e = window[KEY];
  window[KEY] = null;
  if (e && !e.defaultPrevented) document.execCommand(${JSON.stringify(command)});
})()`;
}

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

/** Selects the first option, in document order, whose value or label is the
 *  text: playwright's selectOption rule. Answers false, touching nothing and
 *  firing no event, when no option matches: assigning an unknown value would
 *  deselect every option. */
export function selectScript(selector: string, value: string): string {
  return `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('select: element not found');
        const want = ${JSON.stringify(value)};
        const opt = Array.from(el.options).find((o) => o.value === want || o.label === want);
        if (!opt) return false;
        el.selectedIndex = opt.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`;
}

/** Clicks the element when its checked state differs from `checked`, and
 *  answers true. It answers false, clicking nothing, for `uncheck` of a
 *  checked radio: the click would leave it checked (spec F20). A radio is an
 *  input[type=radio], or an element the last snapshot gave the role radio or
 *  menuitemradio; one without `checked` reads its aria-checked.
 *  aria-checked="mixed" is off for `check`, as in playwright, and on for
 *  `uncheck`: a mixed checkbox usually goes to true on a click (the APG
 *  cycle), so `uncheck` clicks once more when it then reads true. */
export function setCheckedScript(selector: string, checked: boolean): string {
  return `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('check: element not found');
        const input = el instanceof HTMLInputElement;
        const aria = () => el.getAttribute('aria-checked');
        const on = input ? el.checked : aria() === 'true';
        const role = window[Symbol.for('bowser.aria-refs')]?.refs?.get(el)?.role;
        const radio = (input && el.type === 'radio') || role === 'radio' || role === 'menuitemradio';
        if (${!checked} && radio && on) return false;
        const mixed = ${!checked} && !input && !radio && aria() === 'mixed';
        if (on !== ${checked} || mixed) el.click();
        if (mixed && aria() === 'true') el.click();
        return true;
      })()`;
}

/** The inputs whose value `fill` sets in the page, as playwright does: the
 *  native type enters nothing into them. */
const FILL_SET_TYPES = ["date", "time", "datetime-local", "month", "week", "color"];

/** What `fillScript` found: `type` means the caller types the text now;
 *  `set` means the page took it; the rest are refusals, value untouched. */
export type FillOutcome = "type" | "set" | "disabled" | "readonly" | "nan" | "rejected";

/** Readies the element `fill` has just clicked, and answers
 *  `{ outcome: FillOutcome, type }` with the input's type (or ""):
 *  - a disabled (fieldset included) or read-only element is refused;
 *  - on type=number, text Number() reads as NaN is refused, as playwright does;
 *  - a date-like input (FILL_SET_TYPES) gets the trimmed text as its value,
 *    and `input` and `change`; a value the input does not keep is put back
 *    and refused;
 *  - anything else is emptied, like playwright's fill: an input/textarea's
 *    value, or a contenteditable element's content, with the caret put back
 *    inside it (the text node the click placed it in is gone).
 *  The only value read is a date-like input's, never a password field's. */
export function fillScript(selector: string, value: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    const type = el instanceof HTMLInputElement ? el.type : '';
    if (el.matches(':disabled')) return { outcome: 'disabled', type };
    if (el.readOnly === true) return { outcome: 'readonly', type };
    const text = ${JSON.stringify(value)};
    if (type === 'number' && Number.isNaN(Number(text.trim()))) return { outcome: 'nan', type };
    if (${JSON.stringify(FILL_SET_TYPES)}.includes(type)) {
      const v = text.trim(), prev = el.value;
      el.value = v;
      if (el.value !== v) { el.value = prev; return { outcome: 'rejected', type }; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { outcome: 'set', type };
    }
    if ('value' in el) el.value = '';
    else if (el.isContentEditable) { el.textContent = ''; el.focus(); getSelection().collapse(el, 0); }
    else return { outcome: 'type', type };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { outcome: 'type', type }; })()`;
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

// Compiles `body` without running it: whether the code parses that way.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => unknown;
function parses(body: string): boolean {
  try { new AsyncFunction(body); return true; } catch { return false; }
}

/** `run-code`'s script (spec F18). Code that parses as one expression is
 *  evaluated as one, so an IIFE gives its value; any other code is the body
 *  of an async function, so `return` and `await` work. It must also parse as
 *  a body on its own: `1), x = (2` reads as an expression only inside the
 *  wrapper's parentheses. The page answers `{ value }`, or `{ fn: true }` for
 *  a function result (a playwright-cli `async page => …` snippet), which the
 *  command refuses. Parsed here, in Bun: a page's CSP may forbid `Function`. */
export function runCodeScript(code: string): string {
  const expression = parses(`return (\n${code}\n);`) && parses(code);
  const run = expression ? `(\n${code}\n)` : `(async () => {\n${code}\n})()`;
  return `(async () => {
  const value = await ${run};
  return typeof value === 'function' ? { fn: true } : { value };
})()`;
}

/** The ref's element in the live page, as a CSS_PATH computed now, or null
 *  when it is gone: no ref store (a new document), a ref this document never
 *  handed out, an element collected or no longer connected. It also scrolls
 *  the element to the centre when it is outside the viewport or its centre
 *  point is covered (a fixed header), as playwright-cli does before acting:
 *  WebKit's native click waits for its target to be hittable, so a link below
 *  the fold timed out (spec F8). Here it costs no round trip. */
export function resolveRefScript(ref: string, opts: { enabled?: boolean } = {}): string {
  // With `enabled`, a disabled element (DISABLED, the snapshot's rule, with
  // the role the snapshot gave it) answers { disabled: true } instead, before
  // any scroll: click, check and uncheck refuse it at no extra round trip.
  const enabled = opts.enabled ? String.raw`
  const tagOf = (x) => x.tagName.toUpperCase();
  const ariaRole = (x) => store.refs?.get(x)?.role || null;
  ${DISABLED}
  if (isDisabled(el, ariaRole(el))) return { disabled: true };` : "";
  return String.raw`(() => {
  const store = window[Symbol.for('bowser.aria-refs')];
  const el = store?.byRef?.get(${JSON.stringify(ref)})?.deref();
  if (!el || !el.isConnected) return null;${enabled}
  const r = el.getBoundingClientRect();
  const outside = r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth;
  // In view but under something else, like a fixed header: the point a
  // click lands on belongs to another element. Asked of the element's own
  // root, so a shadow root does not answer with its host.
  const hit = outside ? null : el.getRootNode().elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (outside || (hit && hit !== el && !el.contains(hit))) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }
  ${CSS_PATH}
  return cssPath(el);
})()`;
}
