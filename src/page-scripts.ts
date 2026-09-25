// Every JavaScript snippet bowser injects into the page. Builders take user
// input (selectors, keys, values) and embed it with JSON.stringify, which is
// what keeps a selector with quotes from breaking out of the string. This
// file imports nothing from src/ and is the only one allowed to build an
// IIFE string (tests/layers.test.ts).

// The snapshot walker, serialized into the page. It builds the aria tree from
// document.body the way playwright-cli 0.1.x does (its injected script's
// generateAriaTree, trimmed to what bowser prints: no iframes' contents, no
// shadow DOM, no aria-owns) and returns SnapshotResult (src/snapshot.ts).
// Written with String.raw, so backslashes below are plain JavaScript; the
// only things this text may not contain are backticks and dollar-brace.
//
// Refs: every visible node that receives pointer events gets `e<N>`, in DOM
// pre-order. The element -> {ref, role, name} map and the counter live on
// window, so a ref survives between snapshots of one document while the
// element's role and name are unchanged, and a new document starts at e1.
// Each ref is saved with a stable nth-of-type CSS path, which is what the
// action commands resolve.
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const KEY = Symbol.for('bowser.aria-refs');
  const store = window[KEY] || (window[KEY] = { refs: new WeakMap(), last: 0 });

  const styleCache = new Map();
  const styleOf = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };
  const norm = (s) => s.replace(/[​­]/g, '').trim().replace(/\s+/g, ' ');
  const tagOf = (el) => el.tagName.toUpperCase();

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
  const nativelyDisabled = (el) => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(tagOf(el)) &&
    (el.hasAttribute('disabled') || (tagOf(el) === 'OPTION' && !!el.closest('optgroup[disabled]')) || inDisabledFieldset(el));
  const inDisabledFieldset = (el) => {
    const fs = el.closest('fieldset[disabled]');
    if (!fs) return false;
    const legend = fs.querySelector(':scope > legend');
    return !legend || !legend.contains(el);
  };
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
        return tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : (el.textContent || '');
      }
      if (role === 'combobox' || role === 'listbox') {
        o.visited.add(el);
        if (tag === 'SELECT') {
          let selected = [...el.selectedOptions];
          if (!selected.length && el.options.length) selected = [el.options[0]];
          return selected.map((x) => textAlt(x, child)).join(' ');
        }
        return tag === 'INPUT' ? el.value : '';
      }
      if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
        o.visited.add(el);
        const v = el.getAttribute('aria-valuetext');
        if (v !== null) return v;
        const n = el.getAttribute('aria-valuenow');
        return n !== null ? n : (el.getAttribute('value') || '');
      }
      if (role === 'menu') { o.visited.add(el); return ''; }
    }
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) { o.visited.add(el); return ariaLabel; }
    if (role !== 'presentation' && role !== 'none') {
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
        o.visited.add(el);
        if ((el.value || '').trim()) return el.value;
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
  const DISABLED_ROLES = ['application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem',
    'scrollbar', 'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox', 'select',
    'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem'];
  const EXPANDED_ROLES = ['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
    'row', 'rowheader', 'tab', 'treeitem', 'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch'];
  const LEVEL_ROLES = ['heading', 'listitem', 'row', 'treeitem'];
  const SELECTED_ROLES = ['cell', 'gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
  const HEADING_LEVELS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

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
  function addState(n, el) {
    const role = n.role, tag = tagOf(el);
    if (CHECKED_ROLES.includes(role)) {
      let c = false;
      if (tag === 'INPUT' && el.indeterminate) c = 'mixed';
      else if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) c = el.checked;
      else c = el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : false;
      if (c) n.checked = c;
    }
    if (DISABLED_ROLES.includes(role) && ariaDisabled(el, false)) n.disabled = true;
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
  // A unique id, else an nth-of-type chain from <html>. Chains and sibling
  // indexes are memoized: a ref'd node's ancestors are ref'd too, and a long
  // list would otherwise rescan its siblings for every item.
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
  }
  const refs = [];
  function assignRef(n, el) {
    let r = store.refs.get(el);
    if (!r || r.role !== n.role || r.name !== n.name) {
      r = { ref: 'e' + (++store.last), role: n.role, name: n.name };
      store.refs.set(el, r);
    }
    n.ref = r.ref;
    const saved = { id: r.ref, selector: cssPath(el), role: n.role, name: n.name, tag: el.tagName.toLowerCase() };
    if (tagOf(el) === 'A' && el.getAttribute('href')) saved.href = el.getAttribute('href');
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagOf(el)) && el.value) saved.value = String(el.value).slice(0, 120);
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
    if ((tagOf(el) === 'INPUT' && !['checkbox', 'radio', 'file'].includes(el.type)) || tagOf(el) === 'TEXTAREA') {
      n.children.push(el.value);
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

/** Empties the element `fill` is about to type into, like playwright's fill:
 *  an input/textarea's value, or a contenteditable element's content, with the
 *  caret put back inside it (the text node the click placed it in is gone). */
export function clearForFillScript(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return;
    if ('value' in el) el.value = '';
    else if (el.isContentEditable) { el.textContent = ''; el.focus(); getSelection().collapse(el, 0); }
    else return;
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
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
