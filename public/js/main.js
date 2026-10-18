// ── Dashboard: Zustand, Laden, Darstellung ───────────────────────────────────
import { CATEGORIES, METRICS, PERIODS, SIZE_CLASSES, COVERAGE_STEPS, FILTERS, STATUS, DATASET_BANNER,
  REFRESH_MS, DEFAULTS } from './config.js';
import * as api from './api.js';
import { h, clear, icon } from './dom.js';
import * as fmt from './format.js';
import { renderRateChart } from './chart.js';
import { renderFleetMap, renderRouteMap } from './map.js';

// ── Zustand ──────────────────────────────────────────────────────────────────
const state = {
  view: DEFAULTS.view, layout: 'list',
  period: DEFAULTS.period, mode: DEFAULTS.mode, from: null, to: null,
  metric: DEFAULTS.metric,
  filters: { search: '', flag: '', size: '', minCoverage: 0 },
  selected: null,
  fleet: null, summary: null, status: null, health: null,
  error: null, loading: false, loadedAt: null,
};
const $ = (id) => document.getElementById(id);
const metricDef = () => METRICS.find(m => m.key === state.metric && m.enabled) || METRICS[0];
const win = () => (state.period === 'custom'
  ? { period: 'custom', from: state.from, to: state.to }
  : { period: state.period, mode: state.mode });

// Zustand in der Adresszeile (#…), damit Ansichten teilbar sind – ohne Share-Schlüssel
function readHash() {
  const p = new URLSearchParams(window.location.hash.slice(1));
  if (['ranking', 'map'].includes(p.get('view'))) state.view = p.get('view');
  if (p.get('layout') === 'table') state.layout = 'table';
  if (PERIODS.some(x => x.key === p.get('period'))) state.period = p.get('period');
  if (p.get('mode') === 'calendar') state.mode = 'calendar';
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('from') || '') && /^\d{4}-\d{2}-\d{2}$/.test(p.get('to') || '')) {
    state.period = 'custom'; state.from = p.get('from'); state.to = p.get('to');
  }
  if (METRICS.some(m => m.key === p.get('metric') && m.enabled)) state.metric = p.get('metric');
  if (/^\d{9}$/.test(p.get('yacht') || '')) state.selected = p.get('yacht');
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.view !== DEFAULTS.view) p.set('view', state.view);
  if (state.layout !== 'list') p.set('layout', state.layout);
  if (state.period === 'custom') { p.set('from', state.from); p.set('to', state.to); }
  else {
    if (state.period !== DEFAULTS.period) p.set('period', state.period);
    if (state.mode !== DEFAULTS.mode) p.set('mode', state.mode);
  }
  if (state.metric !== DEFAULTS.metric) p.set('metric', state.metric);
  if (state.selected) p.set('yacht', state.selected);
  const hash = p.toString();
  window.history.replaceState(null, '', window.location.pathname + window.location.search + (hash ? `#${hash}` : ''));
}

// ── Laden ────────────────────────────────────────────────────────────────────
let summaryCtl = null;
async function loadAll({ quiet = false } = {}) {
  state.loading = true;
  if (!quiet) markLoading(true);
  try {
    const [fleet, status, health] = await Promise.all([
      api.getFleet(), api.getStatus().catch(() => null), api.getHealth().catch(() => null)]);
    state.fleet = fleet; state.status = status; state.health = health;
    state.error = null;
    await loadSummary({ render: false });   // setzt state.error bei Fehlern selbst
  } catch (err) {
    state.error = err;
  } finally {
    state.loading = false; state.loadedAt = Date.now();
    markLoading(false);
    renderAll();
  }
}

async function loadSummary({ render = true } = {}) {
  if (summaryCtl) summaryCtl.abort();
  summaryCtl = new AbortController();
  if (render) markLoading(true);
  try {
    state.summary = await api.getSummary(win(), { signal: summaryCtl.signal });
    state.error = null;
    handleVisibility(state.summary.meta.visibility);
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.error = err;
  } finally {
    if (render) { markLoading(false); renderAll(); }
  }
}

function markLoading(on) {
  for (const id of ['board', 'kpis']) { const el = $(id); if (el) el.classList.toggle('is-loading', on); }
}

let keyNoticeShown = false;
function handleVisibility(v) {
  if (!v) return;
  if (v.share_key === 'invalid' && !keyNoticeShown) {
    keyNoticeShown = true;
    api.forgetShareKey();
    toast('This shared link is no longer valid. Owner names stay hidden.');
  }
}

// ── Zeilen: Flotte + Summen, Filter, Rang ────────────────────────────────────
function buildRows() {
  const m = metricDef();
  const fleet = state.fleet ? state.fleet.yachts : [];
  const sums = state.summary ? state.summary.rows : [];
  const byMmsi = new Map(sums.map(r => [r.mmsi, r]));
  const seen = new Set();
  const rows = fleet.map(y => {
    seen.add(y.mmsi);
    const sr = byMmsi.get(y.mmsi);
    return combine(y, sr, m);
  });
  for (const sr of sums) if (!seen.has(sr.mmsi)) rows.push(combine({ mmsi: sr.mmsi, name: sr.name, fields: [] }, sr, m));
  // Rang über alle Yachten mit Daten (unabhängig von Suche/Filtern, damit er stabil bleibt)
  const ranked = rows.filter(r => r.hasData && Number.isFinite(r.value)).sort((a, b) => b.value - a.value);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { rows, rankedCount: ranked.length, max: ranked.length ? ranked[0].value : 0 };
}
function combine(y, sr, m) {
  const r = { ...y, ...(sr || {}) };
  r.owner = (sr && sr.owner) || y.owner || 'Owner unknown';
  r.owner_known = sr ? sr.owner_known : !!y.owner_known;
  r.owner_masked = sr ? sr.owner_masked : !!y.owner_masked;
  r.owner_source_url = sr ? sr.owner_source_url : y.owner_source_url || null;
  r.category = (sr && sr.category) || y.category || 'yacht';
  r.hasData = !!sr;
  r.value = sr && m.field ? sr[m.field] : null;
  r.segments = sr && m.field ? [{ category: r.category, value: r.value }] : [];
  return r;
}

function applyFilters(rows) {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  const size = SIZE_CLASSES.find(c => c.key === f.size);
  return rows.filter(r => {
    if (q && ![r.name, r.owner, r.mmsi].some(v => v && String(v).toLowerCase().includes(q))) return false;
    if (f.flag && r.flag_code !== f.flag) return false;
    if (size && !(Number.isFinite(r.length_m) && size.test(r.length_m))) return false;
    if (f.minCoverage > 0 && r.hasData && !((r.coverage || 0) * 100 >= f.minCoverage)) return false;
    if (f.minCoverage > 0 && !r.hasData) return false;
    return true;
  });
}

// ── Darstellung ──────────────────────────────────────────────────────────────
function renderAll() {
  renderBanners();
  renderControls();
  const built = buildRows();
  const rows = applyFilters(built.rows);
  renderKpis(rows, built);
  renderBoard(rows, built);
  renderStatus();
  if (state.selected) renderDetail(built.rows.find(r => r.mmsi === state.selected));
  else closeDetail({ silent: true });
  writeHash();
}

function periodLabel() {
  if (state.period === 'custom') return state.from === state.to ? fmt.date(state.from) : `${fmt.dateShort(state.from)} – ${fmt.date(state.to)}`;
  const p = PERIODS.find(x => x.key === state.period);
  return p[state.mode];
}

function renderBanners() {
  const slot = $('banner-slot');
  clear(slot);
  const ds = (state.summary && state.summary.meta.dataset) || (state.fleet && state.fleet.meta.dataset);
  if (ds && ds !== 'prod') {
    slot.append(h('div', { class: 'banner banner-demo', role: 'note' }, icon('alert', { size: 18 }),
      h('span', {}, h('strong', {}, (DATASET_BANNER[ds] || { title: 'Test data.' }).title), ' ',
        DATASET_BANNER[ds] ? DATASET_BANNER[ds].text : `Dataset “${ds}” is not the public measurement series.`)));
  }
  const v = state.summary && state.summary.meta.visibility;
  if (v && v.via === 'share_key') {
    slot.append(h('div', { class: 'banner banner-share', role: 'note' }, icon('link', { size: 18 }),
      h('span', {}, 'Owner names are visible because you opened a shared link. Please do not pass this link on.'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { api.forgetShareKey(); loadAll(); } }, 'Hide names')));
  }
}

// Steuerleiste: einmal aufbauen, danach nur Zustände setzen
let controlsBuilt = false;
function renderControls() {
  const root = $('controls');
  if (!controlsBuilt) { buildControls(root); controlsBuilt = true; }
  for (const b of root.querySelectorAll('[data-period]')) {
    const on = b.dataset.period === state.period;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on || (state.period === 'custom' && b.dataset.period === 'day') ? 0 : -1;
  }
  const modeSel = root.querySelector('#f-mode');
  modeSel.value = state.period === 'custom' ? 'custom' : state.mode;
  root.querySelector('#f-metric').value = state.metric;
  const custom = root.querySelector('.custom-range');
  custom.hidden = state.period !== 'custom' && !custom.dataset.open;
  // Flaggen aus der Flotte
  const flagSel = root.querySelector('#f-flag');
  const codes = [...new Set((state.fleet ? state.fleet.yachts : []).map(y => y.flag_code).filter(Boolean))].sort();
  const have = [...flagSel.options].map(o => o.value).slice(1);
  if (have.join() !== codes.join()) {
    while (flagSel.options.length > 1) flagSel.remove(1);
    for (const c of codes) flagSel.append(h('option', { value: c }, `${fmt.country(c)} (${c})`));
  }
  flagSel.value = state.filters.flag;
  // Datenbereich
  const meta = state.summary ? state.summary.meta : state.fleet ? state.fleet.meta : null;
  const hint = root.querySelector('.period-hint');
  clear(hint);
  if (meta) {
    if (!meta.data_from) hint.append('No data collected yet.');
    else {
      hint.append(`${periodLabel()}. Data available since ${fmt.date(meta.data_from)}.`);
      if (state.summary && new Date(state.summary.meta.window_from) < new Date(meta.data_from)) {
        hint.append(' This period starts before data collection began, so it shows the data collected so far.');
      }
    }
  }
  const fCount = ['search', 'flag', 'size'].filter(k => state.filters[k]).length + (state.filters.minCoverage ? 1 : 0);
  root.querySelector('.filters-toggle .count').textContent = fCount ? String(fCount) : '';
}

function buildControls(root) {
  clear(root);
  // Zeitraum (zuerst)
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Period' },
    PERIODS.map(p => h('button', { type: 'button', role: 'radio', 'data-period': p.key,
      onclick: () => { state.period = p.key; delete root.querySelector('.custom-range').dataset.open; loadSummary(); refreshDetail(); },
      onkeydown: (e) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const i = PERIODS.findIndex(x => x.key === p.key) + (e.key === 'ArrowRight' ? 1 : -1);
        const next = PERIODS[(i + PERIODS.length) % PERIODS.length];
        root.querySelector(`[data-period="${next.key}"]`).focus();
        e.preventDefault();
      } }, p.label)));
  const mode = h('select', { id: 'f-mode', class: 'select', 'aria-label': 'Period type',
    onchange: (e) => {
      const v = e.target.value;
      const cr = root.querySelector('.custom-range');
      if (v === 'custom') { cr.dataset.open = '1'; cr.hidden = false; cr.querySelector('input').focus(); return; }
      delete cr.dataset.open;
      state.mode = v;
      if (state.period === 'custom') state.period = DEFAULTS.period;
      loadSummary(); refreshDetail();
    } },
  h('option', { value: 'rolling' }, 'Rolling'), h('option', { value: 'calendar' }, 'Calendar (UTC)'),
  h('option', { value: 'custom' }, 'Custom dates…'));
  const today = new Date().toISOString().slice(0, 10);
  const fromIn = h('input', { type: 'date', id: 'f-from', class: 'input', max: today, required: true });
  const toIn = h('input', { type: 'date', id: 'f-to', class: 'input', max: today, required: true });
  const custom = h('form', { class: 'custom-range', hidden: true,
    onsubmit: (e) => {
      e.preventDefault();
      if (!fromIn.value || !toIn.value) return;
      const [a, b] = fromIn.value <= toIn.value ? [fromIn.value, toIn.value] : [toIn.value, fromIn.value];
      state.period = 'custom'; state.from = a; state.to = b;
      loadSummary(); refreshDetail();
    } },
  h('label', { for: 'f-from' }, 'From'), fromIn, h('label', { for: 'f-to' }, 'to'), toIn,
  h('span', { class: 'muted' }, 'UTC, both days included'),
  h('button', { type: 'submit', class: 'btn btn-primary' }, 'Show period'));
  if (state.period === 'custom') { fromIn.value = state.from; toIn.value = state.to; }

  const metric = h('select', { id: 'f-metric', class: 'select', 'aria-label': 'Metric',
    onchange: (e) => { state.metric = e.target.value; renderAll(); refreshDetail({ refetch: false }); } },
  METRICS.map(m => h('option', { value: m.key, disabled: !m.enabled }, m.enabled ? m.label : `${m.label} – ${m.note.toLowerCase()}`)));

  const extra = [];
  for (const f of FILTERS.filter(x => x.enabled)) {
    if (f.key === 'search') {
      let t;
      extra.push(h('label', { class: 'field field-search' }, h('span', { class: 'field-label' }, f.label), icon('search'),
        h('input', { type: 'search', class: 'input', placeholder: f.placeholder, 'aria-label': 'Search yacht or owner',
          oninput: (e) => { clearTimeout(t); t = setTimeout(() => { state.filters.search = e.target.value; renderAll(); }, 150); } })));
    } else if (f.key === 'flag') {
      extra.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label),
        h('select', { id: 'f-flag', class: 'select', onchange: (e) => { state.filters.flag = e.target.value; renderAll(); } },
          h('option', { value: '' }, 'All flags'))));
    } else if (f.key === 'size') {
      extra.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label),
        h('select', { class: 'select', onchange: (e) => { state.filters.size = e.target.value; renderAll(); } },
          h('option', { value: '' }, 'All lengths'), SIZE_CLASSES.map(c => h('option', { value: c.key }, c.label)))));
    } else if (f.key === 'minCoverage') {
      extra.push(h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label),
        h('select', { class: 'select', onchange: (e) => { state.filters.minCoverage = Number(e.target.value); renderAll(); } },
          COVERAGE_STEPS.map(v => h('option', { value: v }, v ? `At least ${v} %` : 'Any')))));
    }
  }
  const extraWrap = h('div', { class: 'controls-extra', id: 'controls-extra' }, extra);
  const toggle = h('button', { type: 'button', class: 'btn btn-quiet filters-toggle', 'aria-expanded': 'false',
    'aria-controls': 'controls-extra',
    onclick: (e) => {
      const open = root.classList.toggle('show-extra');
      e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    } }, icon('filter'), 'Filters', h('span', { class: 'count' }));

  root.append(
    h('div', { class: 'controls-main' },
      h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'period-label' }, 'Period'),
        h('div', { class: 'control-group' }, seg, mode)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Metric'), metric),
      toggle),
    custom, extraWrap,
    h('p', { class: 'period-hint', 'aria-live': 'polite' }));
}

// ── Kennzahlen ───────────────────────────────────────────────────────────────
function renderKpis(rows, built) {
  const root = $('kpis');
  clear(root);
  const m = metricDef();
  const withData = rows.filter(r => r.hasData && Number.isFinite(r.value));
  const total = withData.reduce((a, r) => a + r.value, 0);
  const periodH = state.summary && state.summary.meta.period_h;
  const covH = rows.reduce((a, r) => a + (r.hasData ? r.coverage_h || 0 : 0), 0);
  const fleetCov = periodH && rows.length && state.summary.rows.length ? covH / (rows.length * periodH) : null;
  const top = withData.slice().sort((a, b) => b.value - a.value)[0];
  const tm = fmt.mass(total);
  const empty = !withData.length;

  root.append(
    h('div', { class: 'kpi kpi-hero' },
      h('p', { class: 'kpi-label' }, `${m.long}, total`),
      h('p', { class: 'kpi-value' }, empty ? '–' : tm.num, empty ? '' : h('span', { class: 'kpi-unit' }, ` ${tm.unit}`)),
      h('p', { class: 'kpi-sub' }, `${periodLabel()}, model estimate`)),
    h('div', { class: 'kpi' },
      h('p', { class: 'kpi-label' }, 'Yachts with data'),
      h('p', { class: 'kpi-value' }, `${withData.length}`, h('span', { class: 'kpi-unit' }, ` of ${rows.length}`)),
      h('p', { class: 'kpi-sub' }, rows.length === (state.fleet ? state.fleet.yachts.length : 0) ? 'tracked yachts' : 'yachts matching the filters')),
    h('div', { class: 'kpi' },
      h('p', { class: 'kpi-label' }, 'Data coverage'),
      h('p', { class: 'kpi-value' }, fleetCov === null ? '–' : fmt.pct(fleetCov)),
      meter(fleetCov),
      h('p', { class: 'kpi-sub' }, 'of all yacht-hours in the period')),
    h('div', { class: 'kpi' },
      h('p', { class: 'kpi-label' }, 'Largest single share'),
      h('p', { class: 'kpi-value' }, top && total > 0 ? fmt.pct(top.value / total) : '–'),
      h('p', { class: 'kpi-sub' }, top ? `${top.owner} (${top.name})` : 'no data in this period')),
  );
}

function meter(x, { label } = {}) {
  const v = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
  return h('span', { class: 'meter', role: 'img', 'aria-label': label || `Coverage ${fmt.pct(x)}` },
    h('span', { class: 'meter-fill', style: { width: `${v * 100}%` } }));
}

// ── Board: Ranking (Liste/Tabelle) oder Karte ────────────────────────────────
function renderBoard(rows, built) {
  const root = $('board');
  for (const t of document.querySelectorAll('[data-view]')) {
    t.setAttribute('aria-selected', t.dataset.view === state.view ? 'true' : 'false');
    t.tabIndex = t.dataset.view === state.view ? 0 : -1;
  }
  if (state.view === 'map') {
    const key = JSON.stringify([state.metric, win(), rows.map(r => [r.mmsi, r.value, r.last_seen])]);
    if (root._mapKey === key && root._map) return;
    root._mapKey = key;
    return renderMapView(root, rows);
  }
  root._mapKey = null;
  if (root._map) { root._map.remove(); root._map = null; }
  clear(root);
  const m = metricDef();
  root.className = 'board';
  root.setAttribute('aria-labelledby', 'board-title');
  root.append(h('div', { class: 'board-head' },
    h('div', {},
      h('h2', { id: 'board-title' }, `Ranking by ${m.label}`),
      h('p', { class: 'board-sub' }, state.layout === 'table'
        ? `${periodLabel()}. Sorted by the estimated ${m.phrase} for the time with reports.`
        : `${periodLabel()}. Bar length shows the estimated ${m.phrase} for the time with reports.`)),
    legend(rows),
    h('div', { class: 'layout-switch', role: 'group', 'aria-label': 'Layout' },
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-pressed': state.layout === 'list' ? 'true' : 'false', title: 'Bar list',
        onclick: () => { state.layout = 'list'; renderAll(); } }, icon('list'), h('span', { class: 'sr-only' }, 'Bar list')),
      h('button', { type: 'button', class: 'btn btn-icon', 'aria-pressed': state.layout === 'table' ? 'true' : 'false', title: 'Table',
        onclick: () => { state.layout = 'table'; renderAll(); } }, icon('table'), h('span', { class: 'sr-only' }, 'Table')))));

  if (state.error && !state.summary) return root.append(errorBox(state.error));
  if (state.error) root.append(errorBox(state.error, { compact: true }));

  const withData = rows.filter(r => r.hasData && Number.isFinite(r.value)).sort((a, b) => b.value - a.value);
  const noData = rows.filter(r => !(r.hasData && Number.isFinite(r.value)));
  const anyData = state.summary && state.summary.rows.length > 0;

  if (!anyData) root.append(emptyState());
  else if (!withData.length) root.append(h('div', { class: 'notice' }, 'No yacht matches the filters in this period.'));

  const masked = rows.some(r => r.owner_masked && r.owner_known);
  if (masked) root.append(h('p', { class: 'owner-note' }, icon('eyeOff'),
    'Owner names are hidden in this public view. Aliases such as “Owner 07” stand for an owner backed by a cited source.'));

  if (withData.length && state.layout === 'list') {
    root.append(h('p', { class: 'rank-key' }, meter(0.7, { label: 'Example coverage meter' }),
      'Coverage: share of the period with reports. Emissions are not extrapolated to the rest.'));
  }
  if (withData.length) {
    if (state.layout === 'table') root.append(rankingTable(withData));
    else root.append(rankingList(withData, built.max));
  }
  if (noData.length) {
    const list = h('ul', { class: 'nodata-list' }, noData.map(r => h('li', {},
      h('button', { type: 'button', class: 'nodata-row', 'data-mmsi': r.mmsi, onclick: () => openDetail(r.mmsi) },
        h('span', { class: 'nd-owner' }, r.owner), h('span', { class: 'nd-name' }, r.name),
        h('span', { class: 'nd-meta' }, [r.flag_code, Number.isFinite(r.length_m) ? `${r.length_m} m` : null].filter(Boolean).join(', '))))));
    const det = h('details', { class: 'nodata', open: !anyData },
      h('summary', {}, `${noData.length} ${noData.length === 1 ? 'yacht' : 'yachts'} without data in this period`), list);
    root.append(det);
  }
}

function legend(rows) {
  const cats = [...new Set(rows.filter(r => r.hasData).map(r => r.category))];
  if (cats.length < 2) return h('span', { class: 'legend-spacer' });
  return h('ul', { class: 'legend', 'aria-label': 'Legend' }, cats.map(c => h('li', {},
    h('span', { class: 'swatch', style: { background: `var(${(CATEGORIES[c] || CATEGORIES.yacht).colorVar})` } }),
    (CATEGORIES[c] || { label: c }).label)));
}

function ownerCell(r, { compact = false } = {}) {
  const cls = r.owner_known ? (r.owner_masked ? 'owner is-alias' : 'owner is-named') : 'owner is-unknown';
  const parts = [h('span', { class: 'owner-text' }, r.owner)];
  if (r.owner_known && r.owner_masked && !compact) parts.push(icon('eyeOff', { size: 14, label: 'Name hidden' }));
  return h('span', { class: cls, title: r.owner_masked && r.owner_known ? 'Name hidden in this public view' : null }, parts);
}

function rankingList(rows, max) {
  const m = metricDef();
  const unit = fmt.unitFor(max);
  const ol = h('ol', { class: 'ranking', 'aria-label': `Ranking by ${m.label}` });
  for (const r of rows) {
    const selected = r.mmsi === state.selected;
    const bar = h('span', { class: 'bar-track' }, r.segments.map(sg => h('span', {
      class: 'bar-seg', style: { width: `${max > 0 ? Math.max(0.4, (sg.value / max) * 100) : 0}%`,
        background: `var(${(CATEGORIES[sg.category] || CATEGORIES.yacht).colorVar})` } })));
    const value = fmt.mass(r.value);
    ol.append(h('li', { class: `rank-row${selected ? ' is-selected' : ''}` },
      h('button', { type: 'button', class: 'rank-btn', 'data-mmsi': r.mmsi, 'aria-current': selected ? 'true' : null,
        'aria-label': `Rank ${r.rank}: ${r.owner}, ${r.name}. ${m.label} ${value.text}, coverage ${fmt.pct(r.coverage)}. Open details.`,
        onclick: () => openDetail(r.mmsi) },
      h('span', { class: 'rank-num', 'aria-hidden': 'true' }, String(r.rank)),
      h('span', { class: 'rank-id', 'aria-hidden': 'true' },
        ownerCell(r),
        h('span', { class: 'rank-meta' }, h('span', { class: 'yacht-name' }, r.name),
          [r.flag_code, Number.isFinite(r.length_m) ? `${r.length_m} m` : null].filter(Boolean).map(x => h('span', { class: 'meta-item' }, x)))),
      h('span', { class: 'rank-bar', 'aria-hidden': 'true' }, bar),
      h('span', { class: 'rank-value', 'aria-hidden': 'true' },
        h('span', { class: 'val' }, fmt.massIn(r.value, unit), h('span', { class: 'val-unit' }, ` ${unit}`))),
      h('span', { class: 'cov', 'aria-hidden': 'true' }, meter(r.coverage),
        h('span', { class: 'cov-text' }, fmt.pct(r.coverage), h('span', { class: 'cov-word' }, ' coverage'))))));
  }
  return ol;
}

function rankingTable(rows) {
  const unitOf = (field) => fmt.unitFor(Math.max(...rows.map(r => r[field] || 0)));
  const cols = [
    { k: 'rank', label: 'Rank', num: true, v: r => r.rank },
    { k: 'owner', label: 'Owner', v: r => r.owner },
    { k: 'name', label: 'Yacht', v: r => r.name },
    { k: 'flag', label: 'Flag', v: r => r.flag_code || '–' },
    { k: 'len', label: 'Length (m)', num: true, v: r => (Number.isFinite(r.length_m) ? r.length_m : '–') },
    ...METRICS.filter(m => m.enabled).map(m => { const u = unitOf(m.field); return { k: m.key, label: `${m.label} (${u})`, num: true, v: r => fmt.massIn(r[m.field], u) }; }),
    { k: 'cov', label: 'Coverage', num: true, v: r => fmt.pct(r.coverage) },
    { k: 'last', label: 'Last report', v: r => fmt.dateTime(r.last_seen) },
  ];
  const table = h('table', { class: 'data-table' },
    h('caption', { class: 'sr-only' }, `Emissions by yacht, ${periodLabel()}`),
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { scope: 'col', class: c.num ? 'num' : null }, c.label)))),
    h('tbody', {}, rows.map(r => h('tr', { class: r.mmsi === state.selected ? 'is-selected' : null, tabindex: '0', 'data-mmsi': r.mmsi,
      onclick: () => openDetail(r.mmsi), onkeydown: (e) => { if (e.key === 'Enter') openDetail(r.mmsi); } },
    cols.map(c => h(c.k === 'owner' ? 'th' : 'td', { class: c.num ? 'num' : null, scope: c.k === 'owner' ? 'row' : null },
      c.k === 'owner' ? ownerCell(r, { compact: true }) : c.v(r)))))));
  return h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Emissions table' }, table);
}

function emptyState() {
  const n = state.fleet ? state.fleet.yachts.length : 0;
  const active = state.status && state.status.provider && state.status.provider !== 'none';
  return h('div', { class: 'empty' },
    h('h3', {}, active ? 'No reports in this period yet' : 'No measurements yet'),
    h('p', {}, active
      ? `The data feed is running for ${n} yachts. Reports for this period have not arrived yet; choose a longer period or check back later.`
      : `Tracking of ${n} yachts starts once the data feed is switched on. This page fills in by itself – there is nothing to reload.`));
}

function errorBox(err, { compact = false } = {}) {
  return h('div', { class: `error-box${compact ? ' compact' : ''}`, role: 'alert' }, icon('alert', { size: 18 }),
    h('div', {}, h('strong', {}, 'Data could not be loaded. '), h('span', {}, err.message || 'Unknown error.'),
      compact ? ' Showing the last loaded values.' : ''),
    h('button', { type: 'button', class: 'btn', onclick: () => loadAll() }, icon('refresh'), 'Try again'));
}

async function renderMapView(root, rows) {
  if (root._map) { root._map.remove(); root._map = null; }
  clear(root);
  root.className = 'board board-map';
  const m = metricDef();
  const mapEl = h('div', { class: 'fleet-map', role: 'region', 'aria-label': 'Map of last known positions' });
  const note = h('p', { class: 'board-sub' });
  root.append(h('div', { class: 'board-head' },
    h('div', {}, h('h2', { id: 'board-title' }, 'Last known positions'), note), h('span', { class: 'legend-spacer' })), mapEl,
  h('p', { class: 'map-legend' }, h('span', { class: 'legend-dot big' }), h('span', { class: 'legend-dot' }),
    `Circle area grows with the estimated ${m.phrase} in the period. Select a circle for details.`));
  if (state.error && !state.fleet) return root.append(errorBox(state.error));
  const res = await renderFleetMap(mapEl, { yachts: rows, valueOf: (y) => (y.hasData ? y.value : NaN), metricLabel: m.label,
    onSelect: (mmsi) => openDetail(mmsi), selected: state.selected });
  if (res) {
    const missing = rows.length - res.shown;
    note.textContent = `${periodLabel()}. ${res.shown} of ${rows.length} yachts with a known position${missing ? `; ${missing} without position data` : ''}.`;
  }
  root._map = mapEl._map;
}

// ── Detailpanel ──────────────────────────────────────────────────────────────
let lastFocus = null;
let historyCtl = null;
function openDetail(mmsi) {
  if (state.selected !== mmsi) lastFocus = document.activeElement;
  state.selected = mmsi;
  renderAll();
  const panel = $('detail');
  const head = panel.querySelector('h2');
  if (head) head.focus({ preventScroll: false });
}
function closeDetail({ silent = false } = {}) {
  const panel = $('detail');
  const wasOpen = !panel.hidden;
  panel.hidden = true;
  document.body.classList.remove('detail-open');
  if (panel._map) { panel._map.remove(); panel._map = null; }
  if (!silent) {
    const was = state.selected;
    state.selected = null;
    renderAll();
    // Fokus zurück auf die Zeile, die das Panel geöffnet hat (DOM wurde neu aufgebaut)
    const back = (lastFocus && document.contains(lastFocus) && lastFocus)
      || document.querySelector(`#board [data-mmsi="${was}"]`);
    if (back) back.focus();
  } else if (wasOpen) {
    clear(panel);
  }
}
function refreshDetail({ refetch = true } = {}) { if (state.selected && refetch) detailKey = null; }

let detailKey = null;
function renderDetail(r) {
  const panel = $('detail');
  if (!r) { closeDetail({ silent: true }); return; }
  panel.hidden = false;
  document.body.classList.add('detail-open');
  const m = metricDef();
  const key = `${r.mmsi}|${JSON.stringify(win())}|${r.owner}|${r.owner_masked}|${state.loadedAt}`;
  const sameYacht = panel.dataset.mmsi === r.mmsi;
  if (sameYacht && detailKey === key) { updateDetailFigures(panel, r); return; }
  detailKey = key;
  panel.dataset.mmsi = r.mmsi;
  if (panel._map) { panel._map.remove(); panel._map = null; }
  clear(panel);
  const fleetY = state.fleet && state.fleet.yachts.find(y => y.mmsi === r.mmsi);
  const chartEl = h('div', { class: 'chart-host' }, h('p', { class: 'chart-empty' }, 'Loading reports…'));
  const mapEl = h('div', { class: 'route-map', role: 'region', 'aria-label': 'Route map' });
  const histNote = h('p', { class: 'fine' });

  panel.append(
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'detail-head' },
      h('div', {},
        h('p', { class: 'detail-owner' }, ownerCell(r)),
        h('h2', { tabindex: '-1' }, r.name),
        h('p', { class: 'detail-meta' }, [fmt.country(r.flag_code), Number.isFinite(r.length_m) ? `${r.length_m} m` : null, `MMSI ${r.mmsi}`].filter(Boolean).join(', '))),
      h('button', { type: 'button', class: 'btn btn-icon', onclick: () => closeDetail(), 'aria-label': 'Close details' }, icon('close', { size: 20 }))),
    ownerSource(r),
    h('p', { class: 'detail-rank' }),
    h('p', { class: 'detail-period' }, icon('calendar', { size: 14 }), periodLabel(),
      state.summary ? h('span', { class: 'muted' }, fmt.rangeLabel(state.summary.meta.window_from, state.summary.meta.window_to)) : ''),
    h('div', { class: 'detail-figures' }),
    h('section', { class: 'detail-section' },
      h('h3', {}, 'CO₂ emission rate over time'), chartEl, histNote),
    h('section', { class: 'detail-section' },
      h('h3', {}, 'Route in this period'), mapEl),
    h('section', { class: 'detail-section' },
      h('h3', {}, 'Master data'), masterData(fleetY)),
    h('section', { class: 'detail-section placeholder' },
      h('h3', {}, 'Breakdown by propulsion / hotel load'),
      h('p', {}, 'Coming with model v3. The current model (calc version ', state.health ? state.health.calc_version : '–',
        ') does not separate propulsion from on-board hotel load yet.')),
    h('p', { class: 'fine' }, 'All values are model estimates from AIS reports, not measurements.'));
  updateDetailFigures(panel, r);
  void m;

  if (historyCtl) historyCtl.abort();
  historyCtl = new AbortController();
  api.getHistory(r.mmsi, win(), { signal: historyCtl.signal }).then(({ meta, points }) => {
    const t0 = new Date(meta.window_from).getTime(), t1 = new Date(meta.window_to).getTime();
    const sm = state.summary ? state.summary.meta : {};
    const liveGap = (sm.max_gap_hours || 7) * 3600000, histGap = (sm.max_gap_hours_history || 1) * 3600000;
    const bucket = (meta.bucket_s || 0) * 1000;
    renderRateChart(chartEl, { points, t0, t1,
      gapMs: (p) => Math.max(p.source === 'history' ? histGap : liveGap, bucket) });
    histNote.textContent = meta.downsampled
      ? `${fmt.int(meta.points_raw)} reports, shown as averages per ${fmt.hours(meta.bucket_s / 3600)} for display. Gaps longer than ${sm.max_gap_hours || 7} h (live) or ${sm.max_gap_hours_history || 1} h (track history) are left empty.`
      : `${fmt.int(meta.points_raw)} reports. A rate holds until the next report, for at most ${sm.max_gap_hours || 7} h (live) or ${sm.max_gap_hours_history || 1} h (track history); longer gaps are left empty.`;
    renderRouteMap(mapEl, { points, last: fleetY && fleetY.last_position });
    panel._map = mapEl._map;
  }).catch(err => {
    if (err.name === 'AbortError') return;
    clear(chartEl).append(h('p', { class: 'chart-empty' }, `Reports could not be loaded: ${err.message}`));
  });
}

function updateDetailFigures(panel, r) {
  const box = panel.querySelector('.detail-figures');
  if (!box) return;
  clear(box);
  const fig = (label, value, sub, active) => h('div', { class: `fig${active ? ' is-active' : ''}` },
    h('p', { class: 'fig-label' }, label), h('p', { class: 'fig-value' }, value), sub ? h('p', { class: 'fig-sub' }, sub) : null);
  if (!r.hasData) {
    box.append(h('p', { class: 'notice' }, 'No reports for this yacht in the selected period.'));
    return;
  }
  const m = metricDef();
  for (const mm of METRICS.filter(x => x.enabled)) box.append(fig(mm.label, fmt.mass(r[mm.field]).text, null, mm.key === m.key));
  box.append(
    fig('Coverage', fmt.pct(r.coverage), `${fmt.hours(r.coverage_h)} of ${fmt.hours(r.period_h)}`),
    fig('Last report', fmt.ago(r.last_seen), fmt.dateTime(r.last_seen)));
  const rk = panel.querySelector('.detail-rank');
  if (rk) rk.textContent = r.rank ? `Rank ${r.rank} of ${state.summary ? state.summary.rows.length : '–'} by ${m.label}` : 'Not ranked in this period';
}

function ownerSource(r) {
  if (r.owner_known && !r.owner_masked && r.owner_source_url) {
    return h('p', { class: 'owner-source' }, statusChip('sourced'), ' Ownership source: ',
      h('a', { href: r.owner_source_url, target: '_blank', rel: 'noopener noreferrer' }, hostOf(r.owner_source_url)));
  }
  if (r.owner_known && r.owner_masked) {
    return h('p', { class: 'owner-source' }, statusChip('sourced'), ' Owner backed by a cited source; the name is hidden in this public view.');
  }
  return h('p', { class: 'owner-source' }, statusChip('unverified'), ' Owner not yet researched or not backed by a source.');
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function statusChip(key) {
  const st = STATUS[key] || STATUS.unverified;
  return h('span', { class: `chip chip-${key}`, title: st.hint }, icon(st.icon, { size: 12 }), st.label);
}

function masterData(y) {
  if (!y || !y.fields || !y.fields.length) return h('p', { class: 'fine' }, 'No master data.');
  return h('dl', { class: 'facts' }, y.fields.map(f => h('div', { class: 'fact' },
    h('dt', {}, f.label),
    h('dd', {}, h('span', { class: 'fact-value' }, f.value === null || f.value === undefined ? '–' : `${f.key === 'mmsi' || f.key === 'imo' ? f.value : typeof f.value === 'number' ? fmt.int(f.value) : f.value}${f.unit ? ` ${f.unit}` : ''}`),
      statusChip(f.status), f.note ? h('span', { class: 'fact-note' }, f.note) : null))));
}

// ── Statusleiste ─────────────────────────────────────────────────────────────
function renderStatus() {
  const root = $('statusbar');
  clear(root);
  const st = state.status;
  const meta = state.fleet ? state.fleet.meta : null;
  const active = st && st.provider && st.provider !== 'none';
  const lastUpdate = (st && st.last_30_days && st.last_30_days.last_update) || (meta && meta.data_to);
  const providerName = { myshiptracking: 'MyShipTracking', mock: 'mock provider' }[st && st.provider] || (st && st.provider);
  root.append(
    h('div', { class: 'status-items' },
      h('span', { class: `status-dot ${active ? 'is-on' : 'is-off'}` }, active ? `Data feed: ${providerName}` : 'Data feed: not active yet'),
      h('span', {}, `Last update: ${lastUpdate ? `${fmt.ago(lastUpdate)} (${fmt.dateTime(lastUpdate)})` : '–'}`),
      h('span', {}, `Data since: ${meta && meta.data_from ? fmt.date(meta.data_from) : '–'}`),
      h('span', {}, `Model: calc ${state.health ? state.health.calc_version : '–'}`)),
    h('details', { class: 'method' },
      h('summary', {}, 'How these numbers are made'),
      h('ul', {},
        h('li', {}, 'Positions come from AIS ship tracking, bought from a commercial data provider. Visitors of this page never trigger provider requests.'),
        h('li', {}, `For every report an emission rate is estimated from speed and navigation status with a simplified engine model (calc version ${state.health ? state.health.calc_version : '–'}). A rate holds until the next report, for at most ${(state.summary && state.summary.meta.max_gap_hours) || 7} h for live reports and ${(state.summary && state.summary.meta.max_gap_hours_history) || 1} h for track history.`),
        h('li', {}, 'Coverage is the share of the selected period with reports. Totals are not extrapolated to time without reports.'),
        h('li', {}, 'Owner names are only shown when a cited source backs the ownership, and only where the site owner has made names visible.'),
        h('li', {}, 'Climate impact beyond CO₂ (radiative forcing of NOₓ, sulphur aerosols and other effects) is not shown yet; the method is still being defined.'),
        h('li', {}, 'Calendar periods and dates use UTC.'))));
}

// ── Kleinkram ────────────────────────────────────────────────────────────────
function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('on'), 10);
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 400); }, 6000);
}

function wireViews() {
  for (const t of document.querySelectorAll('[data-view]')) {
    t.addEventListener('click', () => { state.view = t.dataset.view; renderAll(); });
    t.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const next = t.dataset.view === 'ranking' ? 'map' : 'ranking';
      state.view = next; renderAll();
      document.querySelector(`[data-view="${next}"]`).focus();
      e.preventDefault();
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDetail(); });
  $('detail-backdrop').addEventListener('click', () => closeDetail());
}

function init() {
  api.adoptShareKeyFromUrl();
  readHash();
  wireViews();
  loadAll();
  setInterval(() => { if (!document.hidden) loadAll({ quiet: true }); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.loadedAt && Date.now() - state.loadedAt > REFRESH_MS) loadAll({ quiet: true });
  });
}

init();
