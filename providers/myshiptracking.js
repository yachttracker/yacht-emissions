// ── Adapter MyShipTracking (API v2) ─────────────────────────────────────────
// Belegt (API-Doku, abgerufen 2026-10-17):
//   Bulk:  GET /api/v2/vessel/bulk?mmsi=a,b,c&response=simple|extended  (max. 100 IDs)
//          simple 1 Credit/Yacht, extended 3 Credits/Yacht
//          https://api.myshiptracking.com/docs/vessels-current-position-api
//   Track: GET /api/v2/vessel/track?mmsi=..&fromdate=..&todate=..&timegroup=1..60
//          5 Credits je Kalendertag im Ergebnis, max. 90 Tage, 2 Jahre zurück
//          https://api.myshiptracking.com/docs/vessel-historical-track-api
//   Leere Ergebnisse kostenlos; Header X-Credit-Charged; Auth Bearer oder x-api-key.
// Ungeklärt (im Trial prüfen): Zeitstempelformat von received/time, Einheit und
//   Bezugszeitraum von avg_sog/max_sog/distance_covered, Rate-Limit.

const BASE = process.env.MST_BASE_URL || 'https://api.myshiptracking.com/api/v2';

const COSTS = { live_simple: 1, live_extended: 3, history_day: 5 };
const MAX_IDS = 100;

function parseUtc(v) {
  if (v === null || v === undefined || v === '') return null;
  // Annahme: Zeitangaben ohne Zonenangabe sind UTC (Doku sagt "UTC timestamp").
  const s = String(v).trim();
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
}

async function call(path, params) {
  const key = process.env.MST_API_KEY;
  if (!key) throw new Error('MST_API_KEY nicht gesetzt');
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const charged = Number(res.headers.get('x-credit-charged')) || 0;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 404) return { status: 404, charged: 0, data: [] };   // ERR_VESSELS_NOT_FOUND u. ä.: kostenlos
  if (!res.ok) {
    const err = new Error(`MST ${res.status} ${body?.code || ''} ${body?.message || ''}`.trim());
    err.status = res.status; err.code = body?.code; err.charged = charged;
    throw err;
  }
  return { status: res.status, charged, data: Array.isArray(body?.data) ? body.data : (body?.data ? [body.data] : []) };
}

// Live-Positionen für viele Yachten. Rückgabe normalisiert.
async function fetchLive(mmsis, { extended = false } = {}) {
  const out = []; let charged = 0; const calls = [];
  for (let i = 0; i < mmsis.length; i += MAX_IDS) {
    const chunk = mmsis.slice(i, i + MAX_IDS);
    const r = await call('/vessel/bulk', { mmsi: chunk.join(','), response: extended ? 'extended' : 'simple' });
    charged += r.charged; calls.push({ ids: chunk.length, charged: r.charged, status: r.status });
    for (const v of r.data) {
      out.push({
        mmsi: String(v.mmsi),
        lat: num(v.lat), lon: num(v.lng),
        sog: num(v.speed), cog: num(v.course),
        heading: null,                       // im Bulk-Endpunkt nicht enthalten
        nav_status: num(v.nav_status),
        ts: parseUtc(v.received),
        extra: extended ? {
          distance_covered: num(v.distance_covered), max_sog: num(v.max_sog), avg_sog: num(v.avg_sog),
          last_port_dep_utc: parseUtc(v.last_port_dep_utc), current_port: v.current_port ?? null,
          current_port_arr_utc: parseUtc(v.current_port_arr_utc),
        } : null,
      });
    }
  }
  return { positions: out, charged, calls };
}

// Historie einer Yacht für [from, to) in timegroup-Minuten.
async function fetchHistory(mmsi, fromIso, toIso, { timegroup = 5 } = {}) {
  const r = await call('/vessel/track', { mmsi, fromdate: fromIso, todate: toIso, timegroup });
  const positions = r.data.map(p => ({
    mmsi: String(mmsi), lat: num(p.lat), lon: num(p.lng),
    sog: num(p.speed), cog: num(p.course), heading: null, nav_status: null,   // Track liefert keinen nav_status (belegt)
    ts: parseUtc(p.time),
  }));
  return { positions, charged: r.charged, calls: [{ ids: 1, charged: r.charged, status: r.status }] };
}

module.exports = { name: 'myshiptracking', COSTS, fetchLive, fetchHistory, parseUtc };
