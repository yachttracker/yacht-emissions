// ── Datenschicht: eine Funktion je Backend-Endpunkt ──────────────────────────
// Feldänderungen (z. B. durch Modell v3) werden hier auf das Format abgebildet,
// das die Ansichten erwarten. Das Frontend liest nur das eigene Backend.

import { store } from './dom.js';

const session = store('session');
const KEY_NAME = 'ye_share_key';

// Share-Link: ?key=… einmal übernehmen und sofort aus der Adresszeile entfernen
export function adoptShareKeyFromUrl() {
  const url = new URL(window.location.href);
  const key = url.searchParams.get('key');
  if (!key) return false;
  session.set(KEY_NAME, key);
  url.searchParams.delete('key');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  return true;
}
export const shareKey = () => session.get(KEY_NAME);
export const forgetShareKey = () => session.del(KEY_NAME);

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function getJson(path, { signal } = {}) {
  const headers = { Accept: 'application/json' };
  const key = shareKey();
  if (key) headers['x-share-key'] = key;
  let res;
  try {
    res = await fetch(path, { headers, signal, cache: 'no-store' });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('The server could not be reached.', 0);
  }
  let body = null;
  try { body = await res.json(); } catch { /* kein JSON */ }
  if (!res.ok) throw new ApiError((body && body.error) || `Request failed (HTTP ${res.status}).`, res.status);
  return body;
}

// Zeitfenster → Query-Parameter für summary/history
export function windowQuery(w) {
  const p = new URLSearchParams();
  if (w.period === 'custom') { p.set('from', w.from); p.set('to', w.to); }
  else { p.set('period', w.period); p.set('mode', w.mode); }
  return p;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Eine Zeile aus /api/emissions/summary in das Ansichtsformat bringen.
// segments: heute ein Segment je Zeile (Kategorie der Yacht); mit Modell v3 können hier
// mehrere Segmente (z. B. Antrieb, Hotellast) entstehen, ohne dass das Ranking sich ändert.
function mapSummaryRow(r) {
  const row = {
    mmsi: String(r.mmsi), name: r.name, category: r.category || 'yacht',
    flag_code: r.flag_code || null, length_m: num(r.length_m),
    owner: r.owner, owner_alias: r.owner_alias, owner_known: !!r.owner_known,
    owner_masked: !!r.owner_masked, owner_source_url: r.owner_source_url || null,
    co2_kg_total: num(r.co2_kg_total), fuel_kg_total: num(r.fuel_kg_total),
    nox_kg_total: num(r.nox_kg_total), sox_kg_total: num(r.sox_kg_total),
    coverage_h: num(r.coverage_h), coverage_history_h: num(r.coverage_history_h),
    period_h: num(r.period_h), data_points: num(r.data_points), last_seen: r.last_seen,
  };
  row.coverage = row.period_h ? Math.min(1, (row.coverage_h || 0) / row.period_h) : null;
  return row;
}

export async function getSummary(w, opts) {
  const p = windowQuery(w); p.set('meta', '1');
  const body = await getJson(`/api/emissions/summary?${p}`, opts);
  return { meta: body.meta, rows: (body.rows || []).map(mapSummaryRow) };
}

export async function getFleet(opts) {
  const body = await getJson('/api/fleet', opts);
  return {
    meta: body.meta,
    yachts: (body.yachts || []).map(y => ({
      ...y, mmsi: String(y.mmsi), length_m: num(y.length_m),
      owner_known: !!y.owner_known, owner_masked: !!y.owner_masked,
    })),
  };
}

export async function getHistory(mmsi, w, { maxPoints = 1500, ...opts } = {}) {
  const p = windowQuery(w); p.set('meta', '1'); p.set('max_points', String(maxPoints));
  const body = await getJson(`/api/yacht/${encodeURIComponent(mmsi)}/history?${p}`, opts);
  return {
    meta: body.meta,
    points: (body.points || []).map(q => ({
      t: new Date(q.timestamp).getTime(), lat: num(q.latitude), lon: num(q.longitude),
      speed: num(q.speed_knots), co2: num(q.co2_kg_h), fuel: num(q.fuel_kg_h), source: q.source, n: num(q.n) || 1,
    })),
  };
}

export async function getLatest(opts) {
  const rows = await getJson('/api/yachts/latest', opts);
  return (rows || []).map(r => ({
    mmsi: String(r.mmsi), name: r.name, lat: num(r.latitude), lon: num(r.longitude),
    speed: num(r.speed_knots), timestamp: r.timestamp, source: r.source, owner: r.owner,
  }));
}

export const getStatus = (opts) => getJson('/api/status', opts);
export const getHealth = (opts) => getJson('/health', opts);
