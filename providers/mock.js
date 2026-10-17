// ── Mock-Anbieter: synthetische Fahrten, KEINE echten Daten ─────────────────
// Nur für Tests ohne Credits. Kostet "virtuelle" Credits nach den Regeln von
// MyShipTracking, damit Zähler und Tageslimit getestet werden können.
// Wird nur mit ALLOW_MOCK=true akzeptiert; Daten erhalten source='mock_*'.

const COSTS = { live_simple: 1, live_extended: 3, history_day: 5 };
const DAY_MS = 86400000;

function rng(seed) {                       // deterministisch je (mmsi, Tag)
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// Tagesplan: 20 % Fahrtage; Start 9–14 UTC, 1–4 h, 10–14 kn, ostwärts.
function dayPlan(mmsi, dayIdx) {
  const r = rng(hash(`${mmsi}:${dayIdx}`));
  const base = { lat: 43 + (hash(mmsi) % 100) / 100, lon: 7 + (hash(mmsi + 'x') % 100) / 100 };
  if (r() > 0.2) return { base, trip: null };
  const start = 9 + r() * 5, dur = 1 + r() * 3, kn = 10 + r() * 4, ret = r() < 0.5;
  return { base, trip: { start, dur, kn, ret } };
}

function stateAt(mmsi, t) {
  const dayIdx = Math.floor(t / DAY_MS);
  const h = (t - dayIdx * DAY_MS) / 3600000;
  const { base, trip } = dayPlan(mmsi, dayIdx);
  if (!trip || h < trip.start) return { ...base, sog: 0.1, nav: 1 };
  const el = h - trip.start;
  const nmPerDegLon = 60 * Math.cos(base.lat * Math.PI / 180);
  if (el < trip.dur) {
    const half = trip.dur / 2;
    const dist = trip.ret ? (el < half ? el : trip.dur - el) * trip.kn : el * trip.kn;
    return { lat: base.lat, lon: base.lon + dist / nmPerDegLon, sog: trip.kn, nav: 0 };
  }
  const dist = trip.ret ? 0 : trip.dur * trip.kn;
  return { lat: base.lat, lon: base.lon + dist / nmPerDegLon, sog: 0.1, nav: 1 };
}
// Hinweis: Positionen springen am Folgetag zurück zur Basis (vereinfachtes Modell).

async function fetchLive(mmsis, { extended = false, now = Date.now() } = {}) {
  const positions = mmsis.map(m => {
    const s = stateAt(m, now);
    return { mmsi: m, lat: s.lat, lon: s.lon, sog: s.sog, cog: 90, heading: null, nav_status: s.nav,
             ts: new Date(now).toISOString(), extra: extended ? {} : null };
  });
  const charged = positions.length * (extended ? COSTS.live_extended : COSTS.live_simple);
  return { positions, charged, calls: [{ ids: mmsis.length, charged, status: 200 }] };
}

async function fetchHistory(mmsi, fromIso, toIso, { timegroup = 5 } = {}) {
  const t0 = Date.parse(fromIso), t1 = Math.min(Date.parse(toIso), Date.now());
  const positions = []; const days = new Set();
  for (let t = t0; t < t1; t += timegroup * 60000) {
    const s = stateAt(mmsi, t);
    positions.push({ mmsi, lat: s.lat, lon: s.lon, sog: s.sog, cog: 90, heading: null, nav_status: null,
                     ts: new Date(t).toISOString() });
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  const charged = days.size * COSTS.history_day;
  return { positions, charged, calls: [{ ids: 1, charged, status: 200 }] };
}

module.exports = { name: 'mock', COSTS, fetchLive, fetchHistory, stateAt };
