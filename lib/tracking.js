// ── Tracking-Zustand: Pausen mit Grund, Wiedervorlage und automatischer Wiederaufnahme ──
// Konzept (Paul, 2026-10-31): Credits nur dort, wo sie Daten bringen. Liegt eine Yacht belegt
// in der Werft, ist beschlagnahmt oder sendet bewusst kein AIS, wird sie pausiert
// (data/tracking_state.csv, Freigabe per Commit). Pausiert heißt nicht blind: Der wöchentliche
// IMO-Abgleich (lib/identity.js) fragt auch pausierte Yachten ab. Meldet eine Yacht jünger als
// ihre letzte bekannte Meldung (last_seen), wird sie automatisch wieder aktiv; die Tage seit der
// Meldung (höchstens RESUME_BACKFILL_DAYS) kauft die Historie nach (MST: bis 2 Jahre rückwirkend).
//
// Prüfliste (/api/review): Unstimmigkeiten, die eine Web-Recherche auslösen. Damit jede
// Unstimmigkeit nur einmal recherchiert wird, gibt es neben "pause" die Aktion "watch":
// recherchiert, Erklärung belegt (z. B. liegt im Hafen), Yacht wird weiter getrackt, die Hinweise
// "keine frische Meldung/keine Daten/IMO ohne Treffer" ruhen bis zur Wiedervorlage.

const fs = require('fs');
const path = require('path');
const { YACHTS } = require('../fleet');

const ACTIONS = ['pause', 'watch'];
const REASONS = ['refit', 'seized', 'laid_up', 'ais_off', 'in_port', 'imo_missing', 'other'];
const iso = (t) => (t ? new Date(t).toISOString() : null);
const RESUME_BACKFILL_DAYS = 7;
const STALE_DAYS = 7;        // Auslöser für die Recherche, keine Konsequenz fürs Tracking (Annahme)
const DAY_MS = 86400000;
const dayStr = (d) => new Date(d).toISOString().slice(0, 10);

function loadStateCsv(file = path.join(__dirname, '..', 'data', 'tracking_state.csv'), yachts = YACHTS) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = lines.shift().split(';');
  const byImo = new Map(yachts.map(y => [String(y.imo), y]));
  const rows = lines.map((l, i) => {
    const c = l.split(';');
    const r = Object.fromEntries(head.map((h, j) => [h, (c[j] ?? '').trim()]));
    const where = `tracking_state.csv Zeile ${i + 2} (${r.imo})`;
    if (!byImo.has(r.imo)) throw new Error(`${where}: IMO nicht in der Flotte`);
    if (!ACTIONS.includes(r.action)) throw new Error(`${where}: action muss ${ACTIONS.join('|')} sein`);
    if (!REASONS.includes(r.reason)) throw new Error(`${where}: reason muss ${REASONS.join('|')} sein`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.since)) throw new Error(`${where}: since fehlt (YYYY-MM-DD)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.next_check)) throw new Error(`${where}: next_check fehlt (YYYY-MM-DD)`);
    if (r.last_seen && Number.isNaN(Date.parse(r.last_seen))) throw new Error(`${where}: last_seen ungültig`);
    if (!/^https?:\/\//.test(r.source_url)) throw new Error(`${where}: source_url fehlt (nur mit Quelle)`);
    return { ...r, mmsi: byImo.get(r.imo).mmsi };
  });
  if (new Set(rows.map(r => r.imo)).size !== rows.length) throw new Error('tracking_state.csv: IMO doppelt');
  return rows;
}

let STATE = loadStateCsv();   // beim Start geprüft: fehlerhafte Datei → Start schlägt fehl (CI fängt es ab)
// Nur für Tests: Zustand ersetzen, ohne die CSV zu ändern
function setStateForTest(rows) { STATE = rows; }

// Pausierte Yachten (ohne automatisch wieder aufgenommene) → Map mmsi → Zeile
async function paused(pool, dataset, rows = STATE) {
  rows = rows.filter(s => s.action === 'pause');
  if (!rows.length) return new Map();
  const r = await pool.query(`SELECT imo, paused_since::text AS since FROM tracking_resume WHERE dataset = $1`, [dataset]);
  const resumed = new Set(r.rows.map(x => `${x.imo}|${x.since}`));
  return new Map(rows.filter(s => !resumed.has(`${s.imo}|${s.since}`)).map(s => [s.mmsi, s]));
}

// Nach dem IMO-Abgleich: pausierte Yacht mit jüngerer Meldung als last_seen → wieder aktiv
async function resumeFromIdentity(pool, dataset, identityRows, { now = new Date(), rows = STATE } = {}) {
  const pz = await paused(pool, dataset, rows);
  const out = [];
  for (const s of pz.values()) {
    const idr = identityRows.find(r => r.imo === s.imo);
    if (!idr || !idr.ais_received) continue;
    const rec = Date.parse(idr.ais_received);
    const seen = s.last_seen ? Date.parse(s.last_seen) : 0;
    if (!(rec > seen)) continue;
    const from = dayStr(Math.max(rec, Date.parse(dayStr(now)) - RESUME_BACKFILL_DAYS * DAY_MS));
    await pool.query(`
      INSERT INTO tracking_resume (dataset, imo, paused_since, received, ais_mmsi, backfill_from)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [dataset, s.imo, s.since, idr.ais_received, idr.ais_mmsi, from]);
    console.log(`[TRACKING] ${s.name} (${s.imo}) wieder aktiv: Meldung ${idr.ais_received} jünger als last_seen ${s.last_seen || '–'}; Historie ab ${from}`);
    out.push({ imo: s.imo, name: s.name, received: idr.ais_received, backfill_from: from });
  }
  return out;
}

// Zusätzliche Historientage nach einer Wiederaufnahme (über das normale Lookback hinaus)
async function resumeDays(pool, dataset, now = new Date()) {
  const r = await pool.query(`
    SELECT t.imo, t.backfill_from::text AS from FROM tracking_resume t
     WHERE t.dataset = $1 AND t.backfill_from IS NOT NULL AND t.backfill_from >= $2::date`,
  [dataset, dayStr(Date.parse(dayStr(now)) - (RESUME_BACKFILL_DAYS + 3) * DAY_MS)]);
  const byImo = new Map(YACHTS.map(y => [String(y.imo), y]));
  const out = [];
  const yesterday = Date.parse(dayStr(now)) - DAY_MS;
  for (const x of r.rows) {
    const y = byImo.get(x.imo);
    if (!y) continue;
    for (let t = Date.parse(x.from); t <= yesterday; t += DAY_MS) out.push({ mmsi: y.mmsi, name: y.name, day: dayStr(t) });
  }
  return out;
}

// Prüfliste: Unstimmigkeiten, die eine Web-Recherche auslösen (öffentlich, ohne Eigentümer)
async function review(pool, dataset, { now = new Date(), identityLatest = null, rows = STATE } = {}) {
  const items = [];
  let watched = new Set();
  const add = (y, issue, detail, extra = {}) => {
    if (QUIET.includes(issue) && watched.has(String(y.imo))) return;
    items.push({ imo: String(y.imo), mmsi: y.mmsi, name: y.name, issue, detail, ...extra });
  };
  const pz = await paused(pool, dataset, rows);
  const pausedImo = new Set([...pz.values()].map(s => s.imo));
  const today = dayStr(now);
  const watch = rows.filter(s => s.action === 'watch');
  watched = new Set(watch.filter(s => s.next_check > today).map(s => s.imo));   // Hinweise ruhen
  const QUIET = ['stale', 'no_data', 'imo_not_found'];

  // 1. IMO-Abgleich
  const idRows = identityLatest ? identityLatest.rows : [];
  for (const r of idRows) {
    const y = YACHTS.find(x => String(x.imo) === r.imo);
    if (!y) continue;
    // schon übernommen (Flotte führt inzwischen die MMSI, die MST zur IMO meldet) → erledigt
    if (r.result === 'mmsi_changed' && String(r.ais_mmsi) !== String(y.mmsi)) add(y, 'mmsi_changed', `MST führt die IMO unter MMSI ${r.ais_mmsi} (${r.ais_name || '–'}, letzte Meldung ${iso(r.ais_received) || '–'})`, { ais_mmsi: r.ais_mmsi, ais_received: iso(r.ais_received) });
    else if (r.result === 'mmsi_foreign') add(y, 'mmsi_foreign', `extended meldet für MMSI ${y.mmsi} die IMO ${r.static_imo}`);
    else if (r.result === 'no_ais') add(y, 'imo_not_found', 'MST liefert zu dieser IMO keinen Datensatz (IMO bei MST nicht hinterlegt oder kein AIS)');
  }

  // 2. Keine frische Meldung (nur aktive Yachten; Auslöser für die Recherche, kein Ausschluss)
  const last = await pool.query(`SELECT mmsi, MAX(timestamp) AS t FROM positions WHERE dataset = $1 GROUP BY mmsi`, [dataset]);
  const lastBy = new Map(last.rows.map(x => [String(x.mmsi), x.t]));
  for (const y of YACHTS) {
    if (pausedImo.has(String(y.imo))) continue;
    const t = lastBy.get(y.mmsi);
    if (!t) add(y, 'no_data', 'keine Position unter dieser MMSI gespeichert');
    else if (now - new Date(t) > STALE_DAYS * DAY_MS) add(y, 'stale', `letzte Meldung ${new Date(t).toISOString()}`, { last_seen: new Date(t).toISOString() });
  }

  // 3. Pausen: Wiedervorlage fällig
  for (const s of pz.values()) {
    if (s.next_check <= today) add({ imo: s.imo, mmsi: s.mmsi, name: s.name }, 'pause_due', `Pause (${s.reason}) seit ${s.since}, Wiedervorlage ${s.next_check}`);
  }
  for (const s of watch) {
    if (s.next_check <= today) add({ imo: s.imo, mmsi: s.mmsi, name: s.name }, 'watch_due', `beobachtet (${s.reason}) seit ${s.since}, Wiedervorlage ${s.next_check}`);
  }

  // 4. Automatisch wieder aufgenommen, Eintrag in tracking_state.csv noch vorhanden
  const res = await pool.query(`SELECT imo, paused_since::text AS since, received FROM tracking_resume WHERE dataset = $1`, [dataset]);
  for (const x of res.rows) {
    const s = rows.find(r => r.imo === x.imo && r.since === x.since);
    if (s) add({ imo: s.imo, mmsi: s.mmsi, name: s.name }, 'resumed', `automatisch wieder aktiv (Meldung ${new Date(x.received).toISOString()}); Pause-Eintrag entfernen`);
  }

  // 5. Stammdaten unklar
  for (const y of YACHTS) {
    if (y.mmsi_status === 'conflict' || y.mmsi_status === 'unverified') add(y, `mmsi_${y.mmsi_status}`, y.note || '');
  }

  const order = ['mmsi_foreign', 'mmsi_changed', 'resumed', 'pause_due', 'watch_due', 'imo_not_found', 'no_data', 'stale', 'mmsi_conflict', 'mmsi_unverified'];
  items.sort((a, b) => order.indexOf(a.issue) - order.indexOf(b.issue) || a.name.localeCompare(b.name));
  return { generated_at: now.toISOString(), stale_days: STALE_DAYS,
           paused: [...pz.values()].map(({ imo, name, reason, since, last_seen, next_check, source_url }) =>
             ({ imo, name, reason, since, last_seen: last_seen || null, next_check, source_url })),
           watched: watch.map(({ imo, name, reason, since, next_check, source_url }) => ({ imo, name, reason, since, next_check, source_url })),
           count: items.length, items };
}

module.exports = { loadStateCsv, setStateForTest, ACTIONS, REASONS, paused, resumeFromIdentity, resumeDays, review,
                   RESUME_BACKFILL_DAYS, STALE_DAYS };
