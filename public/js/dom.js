// ── Kleine DOM-Helfer ────────────────────────────────────────────────────────
// Texte aus der API (Namen, Eigentümer) immer über textContent einsetzen, nie als HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Einfache Strich-Icons (24er Raster, currentColor)
const ICONS = {
  check: 'M5 12.5l4.2 4.2L19 7',
  tilde: 'M4 13c2.5-3 5-3 8 0s5.5 3 8 0',
  question: 'M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1.1-1.5 2.1V15M12 18.2v.3',
  antenna: 'M12 21v-9M8.5 8.5a5 5 0 0 1 7 0M5.6 5.6a9 9 0 0 1 12.8 0M12 12a.6.6 0 1 0 0-.1',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
  filter: 'M4 6h16M7 12h10M10 18h4',
  map: 'M9 4L3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4zM9 4v13.5M15 6.5V20',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.1M4.5 12h.1M4.5 18h.1',
  table: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  eyeOff: 'M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.2-3.1 3.5M6.3 7.8C4.4 9.1 3.1 10.9 2.5 12c1 1.5 4.5 6 9.5 6 1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  alert: 'M12 4l9 16H3l9-16zM12 10v4.5M12 17.3v.2',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 4v3.5h3.5M4 13a8 8 0 0 0 14.6 4.5M20 20v-3.5h-3.5',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4',
  chevron: 'M9 6l6 6-6 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.2',
};
export function icon(name, { size = 16, label } = {}) {
  const el = s('svg', { viewBox: '0 0 24 24', width: size, height: size, class: `icon icon-${name}`,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null },
  s('path', { d: ICONS[name] || ICONS.info }));
  return el;
}

// Speicher (sessionStorage/localStorage) kann in privaten Fenstern fehlen oder werfen
export function store(kind = 'session') {
  const mem = new Map();
  const backend = () => { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; } };
  return {
    get(k) { try { const b = backend(); return b ? b.getItem(k) : (mem.get(k) ?? null); } catch { return mem.get(k) ?? null; } },
    set(k, v) { try { const b = backend(); if (b) b.setItem(k, v); else mem.set(k, v); } catch { mem.set(k, v); } },
    del(k) { try { const b = backend(); if (b) b.removeItem(k); } catch { /* egal */ } mem.delete(k); },
  };
}
