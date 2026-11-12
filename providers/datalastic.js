// ── Adapter Datalastic (API v0) ─────────────────────────────────────────────
// Belegt (API-Doku https://docs.datalastic.com/, abgerufen 2026-11-07):
//   Auth:    Header x-api-key (Query-Parameter nur noch "legacy")
//   Bulk:    GET /api/v0/vessel_bulk?imo=..&imo=..  (oder mmsi=, uuid=; bis 100 IDs, Parameter wiederholt)
//            1 Credit je gefundenem Schiff (max. 100 je Anfrage); nicht gefundene kostenlos.
//            Passt ein Kennzeichen auf mehrere Schiffe, kommen alle zurück und kosten je 1 Credit.
//   History: GET /api/v0/vessel_history?imo=..&from=YYYY-MM-DD&to=YYYY-MM-DD  (max. 30 Tage ab from)
//            2 Credits je zurückgeliefertem Kalenderdatum; Daten ohne Positionen kostenlos.
//            "days=1 kostet typischerweise 4 Credits" (spannt 2 UTC-Daten) → hier nie `days`, nur from/to.
//            Daten seit 10.08.2021. Gespeichert werden nur Positionsänderungen (Liegezeiten → Lücken).
//            Felder je Punkt: lat, lon, speed, course, heading, destination, last_position_epoch/_UTC
//            (kein navigation_status).
//   Kosten:  Header X-Request-Cost (immer gesetzt, 0 wenn nichts berechnet), X-Requestlimit-Remaining.
//   Fehler:  401 Schlüssel, 402 Credits leer/Abo abgelaufen, 404 nicht gefunden (kostenlos),
//            429 > 600 Aufrufe/min mit Retry-After (Sekunden).
//   Pro/extended (vessel_pro, 3 Credits) gibt es nur einzeln, nicht im Bulk → nicht genutzt.
// Ungeklärt (im Trial prüfen, Rohantwort wird je Endpunkt einmal geloggt):
//   - ob `to` inklusive ist (Standard hier: inklusive, DL_HISTORY_TO_EXCLUSIVE=true schaltet um)
//   - ob die Abfrage über die IMO bei MMSI-Wechseln die ganze Historie liefert (Standard: IMO)
//   - wie dicht die Historie vor Anker ist; ob es eine Obergrenze an Punkten je Antwort gibt
//   - Wortlaut der navigation_status-Texte (Zuordnung unten über Schlüsselwörter)

const { byMmsi, YACHTS } = require('../fleet');

const BASE = process.env.DL_BASE_URL || 'https://api.datalastic.com/api/v0';

// live_extended = live_simple: Datalastic hat kein teureres "extended" im Bulk. Der tägliche
// extended-Abruf der Abruflogik speichert hier nur die Stammdaten (IMO, AIS-MMSI) mit, ohne Aufpreis.
const COSTS = { live_simple: 1, live_extended: 1, history_day: 2 };
// Anbieterspezifische Grenzen der Historie für lib/planner.js und lib/schedule.js
const HISTORY = {
  maxDaysPerCall: 30,          // belegt: "max 30 days from from"
  earliest: '2021-08-10',      // belegt: "Data is available since August 10, 2021"
  recordLimit: null,           // nicht dokumentiert → keine Warnung "Datensatzlimit"
  changesOnly: true,           // belegt: nur Positionsänderungen gespeichert
};
const MAX_IDS = 100;
const TIMEOUT_MS = Number(process.env.DL_TIMEOUT_MS) || 60000;   // Annahme wie bei MST

// Kennung für Abfragen: 'imo' (Standard) oder 'mmsi'. Die IMO ist die feste Identität (Paul, 31.10.);
// mit ihr laufen MMSI-Wechsel nicht mehr ins Leere (Annahme, im Trial prüfen).
const idType = () => (process.env.DL_ID_TYPE === 'mmsi' ? 'mmsi' : 'imo');
const validImo = v => /^\d{7}$/.test(String(v || ''));
const imoByMmsi = new Map(YACHTS.filter(y => validImo(y.imo)).map(y => [String(y.mmsi), String(y.imo)]));
const mmsiByImo = new Map(YACHTS.filter(y => validImo(y.imo)).map(y => [String(y.imo), String(y.mmsi)]));

const rawLogged = new Set();
function logRawOnce(path, status, cost, body) {
  if (rawLogged.has(path) || process.env.DL_LOG_RAW === 'false') return;
  rawLogged.add(path);
  let sample = body;
  const d = body?.data;
  if (Array.isArray(d?.vessels)) sample = { ...body, data: { ...d, vessels: d.vessels.slice(0, 2), n: d.vessels.length } };
  else if (Array.isArray(d?.positions)) sample = { ...body, data: { ...d, positions: d.positions.slice(0, 3), n: d.positions.length } };
  console.log(`[DL] Rohantwort ${path} HTTP ${status}, X-Request-Cost ${cost ?? 'fehlt'}:`, JSON.stringify(sample).slice(0, 1500));
}

function parseUtc(v, epoch) {
  if (v !== null && v !== undefined && v !== '') {
    const s = String(v).trim();
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const e = Number(epoch);
  return Number.isFinite(e) && e > 0 ? new Date(e * 1000).toISOString() : null;
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : n;
}

// Datalastic liefert den AIS-Navigationsstatus als Text (Doku-Beispiel: "Under way using engine").
// emissions.js erwartet den AIS-Code (1 Anker, 5 festgemacht, 8 unter Segeln). Zuordnung nach
// ITU-R M.1371 (Codes 0–8); unbekannte Texte → null (emissions.js nimmt dann SOG/Phase-Standard).
function navCode(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) return Number(v);
  const s = String(v).toLowerCase();
  if (s.includes('sailing')) return 8;
  if (s.includes('anchor')) return 1;
  if (s.includes('moored')) return 5;
  if (s.includes('aground')) return 6;
  if (s.includes('fishing')) return 7;
  if (s.includes('not under command')) return 2;
  if (s.includes('restricted')) return 3;
  if (s.includes('constrained')) return 4;
  if (s.includes('engine')) return 0;
  return null;
}

// Schlüssel prüfen: Leerzeichen am Rand entfernen; sonst nur sichtbare ASCII-Zeichen. Node sendet
// Kopfzeilen als Latin-1 → ein kopiertes Sonderzeichen (z. B. „£“, geschütztes Leerzeichen) kommt bei
// Datalastic als ungültiges Byte an (belegt: 401 „invalid byte sequence … 0xa3“, 12.11.2026).
// Die Meldung nennt nur Stelle und Zeichencode, nie den Schlüssel.
function apiKey(raw = process.env.DL_API_KEY) {
  const key = String(raw || '').trim();
  const fail = (msg) => { const e = new Error(msg); e.status = 401; e.charged = 0; e.chargedKnown = true; return e; };
  if (!key) throw fail('DL_API_KEY nicht gesetzt');
  const chars = [...key];
  const bad = chars.findIndex(ch => { const c = ch.codePointAt(0); return c < 0x21 || c > 0x7e; });
  if (bad >= 0) {
    const cp = chars[bad].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw fail(`DL_API_KEY enthält an Stelle ${bad + 1} von ${chars.length} ein unzulässiges Zeichen (U+${cp}); ` +
      'Schlüssel neu aus dem Datalastic-Profil kopieren und in Railway ersetzen');
  }
  return key;
}

async function call(path, params, attempt = 1) {
  const key = apiKey();
  const qs = new URLSearchParams();
  for (const [k, v] of params) qs.append(k, v);
  const url = `${BASE}${path}?${qs}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'x-api-key': key, Accept: 'application/json' },
                             signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const err = new Error(`Datalastic Netzfehler: ${e.name === 'TimeoutError' ? `Zeitlimit ${TIMEOUT_MS} ms` : e.message}`);
    err.status = null; err.charged = 0; err.chargedKnown = false;
    throw err;
  }
  if (res.status === 429 && attempt <= 3) {
    // belegt: Retry-After in Sekunden; ohne Angabe 20/40/60 s (Annahme). 429 kostet nichts (belegt).
    const ra = Math.min(Number(res.headers.get('retry-after')) || 20 * attempt, 120);
    await new Promise(r => setTimeout(r, ra * 1000));
    return call(path, params, attempt + 1);
  }
  const hdr = res.headers.get('x-request-cost');
  const headerPresent = hdr !== null && hdr !== '';
  const charged = Number(hdr) || 0;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  logRawOnce(path, res.status, headerPresent ? charged : null, body);
  if (res.status === 404) return { status: 404, charged: 0, headerPresent: true, body: null };   // nicht gefunden: kostenlos
  if (!res.ok || body?.meta?.success === false) {
    const msg = body?.meta?.message || body?.message || body?.error || '';
    const err = new Error(`Datalastic ${res.status} ${msg}`.trim());
    err.status = res.status; err.charged = charged; err.chargedKnown = headerPresent;
    throw err;
  }
  return { status: res.status, charged, headerPresent, body,
           remaining: num(res.headers.get('x-requestlimit-remaining')) };
}

function chargedOrEstimate(r, estimate, hasData) {
  if (r.headerPresent) return { charged: r.charged, estimated: false };
  return hasData ? { charged: estimate, estimated: true } : { charged: 0, estimated: false };
}

const vesselsOf = body => (Array.isArray(body?.data?.vessels) ? body.data.vessels
  : Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : []);

// Bulk-Abruf (≤ 100 IDs je Teil). ids = Flotten-MMSIs; abgefragt wird je nach DL_ID_TYPE über die IMO.
// Rückgabe je Teil wie beim MST-Adapter (calls), damit Teilerfolge und Abbuchungen sichtbar bleiben.
async function bulk(queries) {
  const records = []; let charged = 0; const calls = [];
  for (let i = 0; i < queries.length; i += MAX_IDS) {
    const chunk = queries.slice(i, i + MAX_IDS);
    let r;
    try {
      r = await call('/vessel_bulk', chunk.map(q => [q.type, q.id]));
    } catch (e) {
      charged += e.charged || 0;
      calls.push({ ids: chunk.length, charged: e.charged || 0, status: e.status ?? null, error: e.message,
                   chargedKnown: !!e.chargedKnown });
      if (e.status === 401 || e.status === 402) break;
      continue;
    }
    const vs = vesselsOf(r.body);
    const c = chargedOrEstimate(r, vs.length * COSTS.live_simple, vs.length > 0);
    charged += c.charged;
    calls.push({ ids: chunk.length, charged: c.charged, estimated: c.estimated, status: r.status, returned: vs.length,
                 remaining: r.remaining ?? null });
    records.push(...vs);
  }
  if (calls.length && calls.every(c => c.error)) {
    const err = new Error(calls.map(c => c.error).join(' | '));
    err.status = calls[0].status; err.charged = charged; err.calls = calls;
    throw err;
  }
  return { records, charged, calls };
}

function queriesFor(mmsis) {
  const byImo = idType() === 'imo';
  return mmsis.map(m => (byImo && imoByMmsi.has(String(m))
    ? { type: 'imo', id: imoByMmsi.get(String(m)), fleetMmsi: String(m) }
    : { type: 'mmsi', id: String(m), fleetMmsi: String(m) }));
}

// Antwort-Datensatz → Flotten-MMSI (über IMO, sonst MMSI)
function fleetMmsiOf(v, wanted) {
  const imo = validImo(v.imo) ? String(v.imo) : null;
  if (imo && mmsiByImo.has(imo) && wanted.has(mmsiByImo.get(imo))) return mmsiByImo.get(imo);
  const m = v.mmsi ? String(v.mmsi) : null;
  if (m && wanted.has(m)) return m;
  return null;
}

// Live-Positionen. Je Flottenyacht der jüngste Datensatz (mehrere Treffer je IMO möglich, belegt).
async function fetchLive(mmsis, { extended = false } = {}) {
  const qs = queriesFor(mmsis);
  const wanted = new Set(qs.map(q => q.fleetMmsi));
  const { records, charged, calls } = await bulk(qs);
  const best = new Map();
  for (const v of records) {
    const fm = fleetMmsiOf(v, wanted);
    if (!fm) continue;
    const ts = parseUtc(v.last_position_UTC, v.last_position_epoch);
    const prev = best.get(fm);
    if (!prev || (ts && (!prev.ts || ts > prev.ts))) best.set(fm, { v, ts });
  }
  const out = [];
  for (const [fm, { v, ts }] of best) {
    const aisMmsi = v.mmsi ? String(v.mmsi) : null;
    out.push({
      mmsi: fm,
      lat: num(v.lat), lon: num(v.lon),
      sog: num(v.speed), cog: num(v.course),
      heading: num(v.heading),
      nav_status: navCode(v.navigation_status),
      ts,
      // Kein current_port im Bulk (nur vessel_pro, 3 Credits einzeln) → Hafen/Anker über nav_status 5/1
      extra: extended ? { ais_mmsi: aisMmsi, destination: v.destination ?? null, navigation_status_text: v.navigation_status ?? null } : null,
      static: extended ? {
        imo: validImo(v.imo) ? String(v.imo) : null, callsign: v.callsign ?? null,
        vessel_type: v.type_specific ?? v.type ?? null, ais_type: v.type ?? null, flag: v.country_iso ?? null,
        gt: null, dwt: null, built: null, draught: null, length_m: null, beam_m: null,
        raw: { ...v, fleet_mmsi: fm },
      } : null,
    });
  }
  return { positions: out, charged, calls };
}

// Identitätsabgleich (lib/identity.js): Bulk über die IMO, alle Datensätze zurück.
async function fetchByImo(imos) {
  const { records, charged, calls } = await bulk(imos.map(id => ({ type: 'imo', id: String(id) })));
  return {
    records: records.map(v => ({ imo: validImo(v.imo) ? String(v.imo) : null, mmsi: v.mmsi ? String(v.mmsi) : null,
      name: v.name ?? null, received: parseUtc(v.last_position_UTC, v.last_position_epoch),
      lat: num(v.lat), lon: num(v.lon), sog: num(v.speed) })),
    charged, calls,
  };
}

const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Historie einer Yacht für die UTC-Tage von fromIso bis toIso (ganze Tage, wie lib/planner.js sie bildet).
// Abfrage immer mit from/to als Datum, nie mit `days` (sonst 1 Datum mehr berechnet, belegt).
async function fetchHistory(mmsi, fromIso, toIso) {
  const fromDay = String(fromIso).slice(0, 10);
  const lastDay = String(toIso).slice(0, 10);
  const span = Math.round((Date.parse(lastDay) - Date.parse(fromDay)) / 86400000) + 1;
  if (span > HISTORY.maxDaysPerCall) throw new Error(`Datalastic: ${span} Tage > ${HISTORY.maxDaysPerCall} je Abfrage`);
  const toParam = process.env.DL_HISTORY_TO_EXCLUSIVE === 'true' ? addDay(lastDay, 1) : lastDay;
  const [q] = queriesFor([mmsi]);
  const r = await call('/vessel_history', [[q.type, q.id], ['from', fromDay], ['to', toParam]]);
  const raw = Array.isArray(r.body?.data?.positions) ? r.body.data.positions : [];
  const all = raw.map(p => ({
    mmsi: String(mmsi), lat: num(p.lat), lon: num(p.lon),
    sog: num(p.speed), cog: num(p.course), heading: num(p.heading), nav_status: null,   // Historie ohne Status (belegt)
    ts: parseUtc(p.last_position_UTC, p.last_position_epoch),
  })).filter(p => p.ts).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));   // Doku-Beispiel absteigend
  // Nur angefragte Tage speichern; Punkte außerhalb zählen als Hinweis (evtl. mitberechnet)
  const lo = `${fromDay}T00:00:00.000Z`, hi = `${addDay(lastDay, 1)}T00:00:00.000Z`;
  const positions = all.filter(p => p.ts >= lo && p.ts < hi);
  const datesReturned = new Set(all.map(p => p.ts.slice(0, 10))).size;
  const c = chargedOrEstimate(r, datesReturned * COSTS.history_day, all.length > 0);
  return { positions, charged: c.charged,
           calls: [{ ids: 1, charged: c.charged, estimated: c.estimated, status: r.status, returned: raw.length,
                     outside_range: all.length - positions.length, dates_returned: datesReturned,
                     remaining: r.remaining ?? null }] };
}

module.exports = { name: 'datalastic', COSTS, HISTORY, fetchLive, fetchHistory, fetchByImo, parseUtc, navCode, apiKey };
