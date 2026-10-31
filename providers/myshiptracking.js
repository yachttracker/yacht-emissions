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
// Zeitlimit je Aufruf. Annahme: 60 s (ein Sammelabruf über 100 IDs dauert erfahrungsgemäß
// wenige Sekunden; ohne Grenze würde ein hängender Aufruf alle folgenden Abrufe blockieren).
const TIMEOUT_MS = Number(process.env.MST_TIMEOUT_MS) || 60000;

// Rohantwort je Endpunkt einmal pro Prozess ins Log (ohne Schlüssel, gekürzt), um Format,
// Zeitstempel und eine evtl. Trial-Maskierung der Koordinaten prüfen zu können (Prüfbericht W3).
const rawLogged = new Set();
function logRawOnce(path, status, charged, headerPresent, body) {
  if (rawLogged.has(path) || process.env.MST_LOG_RAW === 'false') return;
  rawLogged.add(path);
  const sample = Array.isArray(body?.data) ? { ...body, data: body.data.slice(0, 2), n: body.data.length } : body;
  console.log(`[MST] Rohantwort ${path} HTTP ${status}, X-Credit-Charged ${headerPresent ? charged : 'fehlt'}:`,
    JSON.stringify(sample).slice(0, 1500));
}

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

// Rate-Limit: 2.000 Aufrufe/min, Trial 90/min (belegt: api.myshiptracking.com).
// Bei 429 bis zu 3× mit 20/40/60 s Pause wiederholen (429 kostet keine Credits, Annahme).
async function call(path, params, attempt = 1) {
  const key = process.env.MST_API_KEY;
  if (!key) throw new Error('MST_API_KEY nicht gesetzt');
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
                             signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // Zeitüberschreitung oder Netzfehler: ob MST abgebucht hat, ist unbekannt (ungeklärt).
    const err = new Error(`MST Netzfehler: ${e.name === 'TimeoutError' ? `Zeitlimit ${TIMEOUT_MS} ms` : e.message}`);
    err.status = null; err.charged = 0; err.chargedKnown = false;
    throw err;
  }
  if (res.status === 429 && attempt <= 3) {
    await new Promise(r => setTimeout(r, 20000 * attempt));
    return call(path, params, attempt + 1);
  }
  // Belegt (MST-Doku Bulk/Track): Header nur bei einer Abbuchung. Fehlt er, ist charged = 0,
  // headerPresent = false; der Aufrufer schätzt dann bei nichtleerer Antwort (Prüfbericht W2).
  const hdr = res.headers.get('x-credit-charged');
  const headerPresent = hdr !== null && hdr !== '';
  const charged = Number(hdr) || 0;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  logRawOnce(path, res.status, charged, headerPresent, body);
  if (res.status === 404) return { status: 404, charged: 0, headerPresent, data: [] };   // ERR_VESSELS_NOT_FOUND u. ä.: kostenlos
  if (!res.ok) {
    const err = new Error(`MST ${res.status} ${body?.code || ''} ${body?.message || ''}`.trim());
    err.status = res.status; err.code = body?.code; err.charged = charged; err.chargedKnown = headerPresent;
    throw err;
  }
  return { status: res.status, charged, headerPresent,
           data: Array.isArray(body?.data) ? body.data : (body?.data ? [body.data] : []) };
}

// Abbuchung je Aufruf: Header, sonst Schätzung aus der Antwort (nur wenn Daten kamen).
function chargedOrEstimate(r, estimate) {
  if (r.headerPresent) return { charged: r.charged, estimated: false };
  return r.data.length ? { charged: estimate, estimated: true } : { charged: 0, estimated: false };
}

// Live-Positionen für viele Yachten. Rückgabe normalisiert.
// Je Teilabruf (≤ 100 IDs) einzeln abgesichert (Prüfbericht K1): scheitert ein Teil, bleiben die
// bereits bezahlten Daten der anderen Teile erhalten; jeder Teil liefert einen eigenen Eintrag in
// `calls` (Status, Credits, Fehler). Geworfen wird nur, wenn kein Teil erfolgreich war.
async function fetchLive(mmsis, { extended = false } = {}) {
  const out = []; let charged = 0; const calls = [];
  const unit = extended ? COSTS.live_extended : COSTS.live_simple;
  for (let i = 0; i < mmsis.length; i += MAX_IDS) {
    const chunk = mmsis.slice(i, i + MAX_IDS);
    let r;
    try {
      r = await call('/vessel/bulk', { mmsi: chunk.join(','), response: extended ? 'extended' : 'simple' });
    } catch (e) {
      charged += e.charged || 0;
      calls.push({ ids: chunk.length, charged: e.charged || 0, status: e.status ?? null, error: e.message,
                   code: e.code ?? null, chargedKnown: !!e.chargedKnown });
      if (e.status === 401 || e.status === 402) break;   // Schlüssel/Guthaben: weitere Teile zwecklos
      continue;
    }
    const c = chargedOrEstimate(r, r.data.length * unit);
    charged += c.charged;
    calls.push({ ids: chunk.length, charged: c.charged, estimated: c.estimated, status: r.status, returned: r.data.length });
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
          last_port_dep_utc: parseUtc(v.last_port_dep_utc), current_port: v.current_port || null,
          current_port_arr_utc: parseUtc(v.current_port_arr_utc),
        } : null,
        static: extended ? {
          imo: v.imo ? String(v.imo) : null, callsign: v.callsign ?? null,
          vessel_type: v.vessel_type ?? null, ais_type: v.ais_type ?? null, flag: v.flag ?? null,
          gt: num(v.gt), dwt: num(v.dwt), built: num(v.built), draught: num(v.draught),
          length_m: num(v.size_a) !== null && num(v.size_b) !== null ? num(v.size_a) + num(v.size_b) : null,
          beam_m: num(v.size_c) !== null && num(v.size_d) !== null ? num(v.size_c) + num(v.size_d) : null,
          raw: v,
        } : null,
      });
    }
  }
  if (calls.length && calls.every(c => c.error)) {
    const err = new Error(calls.map(c => c.error).join(' | '));
    err.status = calls[0].status; err.code = calls[0].code; err.charged = charged; err.calls = calls;
    throw err;
  }
  return { positions: out, charged, calls };
}

// Historie einer Yacht für [from, to) in timegroup-Minuten.
async function fetchHistory(mmsi, fromIso, toIso, { timegroup = 5 } = {}) {
  const r = await call('/vessel/track', { mmsi, fromdate: fromIso, todate: toIso, timegroup });
  // Schätzung bei fehlendem Header: 5 Credits je Kalendertag mit Daten (belegt: Track-Doku)
  const daysWithData = new Set(r.data.map(p => String(parseUtc(p.time) || '').slice(0, 10)).filter(Boolean)).size;
  const c = chargedOrEstimate(r, daysWithData * COSTS.history_day);
  const positions = r.data.map(p => ({
    mmsi: String(mmsi), lat: num(p.lat), lon: num(p.lng),
    sog: num(p.speed), cog: num(p.course), heading: null, nav_status: null,   // Track liefert keinen nav_status (belegt)
    ts: parseUtc(p.time),
  }));
  return { positions, charged: c.charged,
           calls: [{ ids: 1, charged: c.charged, estimated: c.estimated, status: r.status, returned: r.data.length }] };
}

module.exports = { name: 'myshiptracking', COSTS, fetchLive, fetchHistory, parseUtc };
