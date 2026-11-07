// Abruflogik gegen eine echte PostgreSQL, MST-Antworten über ein Test-Double für fetch.
// Prüft die Befunde des Prüfberichts 2026-10-31: K1 (Teilabruf scheitert), W2 (Header fehlt,
// Zählung je Datensatz), W3 (maskierte Historie) sowie den Restbudget-Rückwärtsabruf.
// Eigener Datensatz 'pltest', wird vorher und nachher gelöscht.
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/planner.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { migrate } = require('../lib/schema');
const { loadConfig } = require('../lib/config');
const credits = require('../lib/credits');
const planner = require('../lib/planner');
const mst = require('../providers/myshiptracking');
const dl = require('../providers/datalastic');
const { YACHTS } = require('../fleet');

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
const DS = 'pltest';
const realFetch = global.fetch;
process.env.MST_API_KEY = 'test-key';
process.env.MST_LOG_RAW = 'false';
process.env.DL_API_KEY = 'test-key';
process.env.DL_LOG_RAW = 'false';

const cfgFor = (extra = {}) => ({
  ...loadConfig({ AIS_PROVIDER: 'myshiptracking', AIS_DATASET: DS, CREDIT_MONTH_BUDGET: '50000',
    CREDIT_DAILY_CAP: '1800', POLL_HOURS_UTC: 'auto' }),
  ...extra,
});

function respond(status, body, charged) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (charged !== undefined) headers.set('x-credit-charged', String(charged));
  return new Response(JSON.stringify(body), { status, headers });
}
const bulkItem = (mmsi, i) => ({ mmsi: Number(mmsi), lat: 43 + i / 1000, lng: 7 + i / 1000, speed: 0.1,
  course: 0, nav_status: 1, received: '2026-10-31T12:00:00Z' });

async function clean() {
  for (const t of ['positions', 'vessel_days', 'credit_log', 'vessel_static']) {
    await pool.query(`DELETE FROM ${t} WHERE dataset = $1`, [DS]);
  }
}
async function logRows() {
  return (await pool.query(`SELECT kind, ids, credits, http_status, note FROM credit_log WHERE dataset = $1 ORDER BY id`, [DS])).rows;
}

before(async () => { await migrate(pool); await clean(); });
after(async () => { global.fetch = realFetch; await clean(); await pool.end(); });

test('K1: zweiter Teilabruf scheitert → Teilergebnis gespeichert, je Teilabruf ein credit_log-Eintrag', async () => {
  await clean();
  assert.ok(YACHTS.length > 100, 'Flotte > 100 nötig, damit geteilt wird');
  let n = 0;
  global.fetch = async (url) => {
    n++;
    const ids = new URL(url).searchParams.get('mmsi').split(',');
    if (n === 1) return respond(200, { status: 'success', data: ids.map(bulkItem) }, ids.length);
    return respond(402, { status: 'error', code: 'ERR_NO_CREDITS', message: 'no credits' });
  };
  const cfg = cfgFor();
  const r = await planner.pollLive(pool, mst, cfg, { now: new Date('2026-10-31T12:05:00Z') });
  assert.equal(n, 2);
  assert.equal(r.charged, 100);
  const rows = await logRows();
  assert.equal(rows.length, 2, 'ein Eintrag je Teilabruf');
  assert.deepEqual(rows.map(x => [x.ids, x.credits, x.http_status]), [[100, 100, 200], [YACHTS.length - 100, 0, 402]]);
  const pos = await pool.query(`SELECT count(*)::int c FROM positions WHERE dataset = $1`, [DS]);
  assert.equal(pos.rows[0].c, 100, 'bezahlte Positionen des ersten Teils sind gespeichert');
});

test('K1: alle Teilabrufe scheitern → Fehler, trotzdem Log-Einträge', async () => {
  await clean();
  global.fetch = async () => respond(401, { status: 'error', code: 'ERR_INVALID_KEY', message: 'bad key' });
  await assert.rejects(planner.pollLive(pool, mst, cfgFor(), { now: new Date('2026-10-31T12:05:00Z') }));
  const rows = await logRows();
  assert.equal(rows.length, 1, '401 bricht nach dem ersten Teil ab');
  assert.equal(rows[0].http_status, 401);
});

test('W2: fehlender X-Credit-Charged bei Daten → Schätzung zählt, Zählung je Datensatz', async () => {
  await clean();
  global.fetch = async (url) => {
    const ids = new URL(url).searchParams.get('mmsi').split(',');
    return respond(200, { status: 'success', data: ids.map(bulkItem) });   // ohne Header
  };
  const cfg = cfgFor();
  await planner.pollLive(pool, mst, cfg, { now: new Date() });
  const st = await credits.status(pool, cfg, 'myshiptracking', new Date());
  assert.equal(st.today_spent, YACHTS.length, 'Schätzung 1 Credit je gelieferter Yacht');
  assert.ok((await logRows()).every(x => /geschätzt/.test(x.note)));
  // anderer Datensatz zählt nicht mit
  const other = await credits.status(pool, { ...cfg, dataset: 'pltest-other' }, 'myshiptracking', new Date());
  assert.equal(other.today_spent, 0);
});

test('W3: maskierte Historie → Status invalid, wird nicht erneut gekauft', async () => {
  await clean();
  const day = '2026-10-30';
  global.fetch = async () => respond(200, { status: 'success', data: [
    { time: `${day}T10:00:00Z`, lat: null, lng: null, speed: 5, course: 10 },
    { time: `${day}T10:15:00Z`, lat: null, lng: null, speed: 5, course: 10 },
  ] }, 5);
  const cfg = cfgFor({ historyMaxDays: 1, lookbackDays: 1 });
  const r = await planner.runHistory(pool, mst, cfg, { now: new Date('2026-10-31T03:30:00Z') });
  assert.equal(r.days_invalid, 1);
  const row = (await pool.query(`SELECT history_status, history_credits FROM vessel_days WHERE dataset = $1`, [DS])).rows[0];
  assert.equal(row.history_status, 'invalid');
  assert.equal(row.history_credits, 5);
  const cands = await planner.buildHistoryCandidates(pool, cfg, { now: new Date('2026-10-31T03:30:00Z'), lookbackDays: 1 });
  assert.equal(cands.filter(c => c.day === day).length, YACHTS.length - 1, 'invalid-Tag nicht erneut Kandidat');
});

test('Stichprobe: HISTORY_MAX_DAYS begrenzt den Historienlauf', async () => {
  await clean();
  const plan = await planner.planHistory(pool, mst, cfgFor({ historyMaxDays: 20 }), { now: new Date('2026-11-01T03:30:00Z') });
  assert.equal(plan.selected.length, 20);
  assert.equal(plan.expected_credits, 100);
});

test('Rückwärtsabruf: nur in den letzten Periodentagen, ältere Tage, älteste zuerst (Standard)', async () => {
  await clean();
  const base = { backfillDays: 365, backfillTailDays: 2, periodStartDay: 1 };
  // Mitte der Periode: kein Rückwärtsabruf
  const mid = await planner.planHistory(pool, mst, cfgFor(base), { now: new Date('2026-11-15T03:30:00Z') });
  assert.equal(mid.backfill.days, 0);
  // vorletzter Tag der Periode (29.11., Periodenende 01.12.): Rückwärtsabruf aktiv
  const tail = await planner.planHistory(pool, mst, cfgFor(base), { now: new Date('2026-11-29T03:30:00Z') });
  assert.ok(tail.backfill.days > 1000, `erwartet > 1000 Yacht-Tage, war ${tail.backfill.days}`);
  // Standard: älteste Tage zuerst → das Fenster beginnt am ältesten Tag (365 Tage zurück), nicht am Regel-Lookback
  assert.equal(tail.backfill.from, '2025-11-29', 'älteste Tage zuerst: beginnt 365 Tage zurück');
  assert.ok(tail.backfill.from < tail.backfill.to);
  assert.ok(tail.backfill_calls[0].days[0] <= tail.backfill_calls.at(-1).days[0], 'aufsteigend');
  // alte Logik: jüngste zuerst
  const newest = await planner.planHistory(pool, mst, cfgFor({ ...base, backfillOrder: 'newest' }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(newest.backfill.to, '2026-11-25', 'jüngste zuerst: beginnt am Tag vor dem Regel-Lookback (3 Tage)');
  // Untergrenze und 2-Jahres-Kante
  const from25 = await planner.planHistory(pool, mst, cfgFor({ ...base, backfillDays: 725, backfillFrom: '2026-01-01' }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(from25.backfill.from, '2026-01-01', 'Untergrenze HISTORY_BACKFILL_FROM');
  const deep = await planner.planHistory(pool, mst, cfgFor({ ...base, backfillDays: 5000 }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(deep.backfill.from, '2024-12-04', 'höchstens 725 Tage zurück (2 Jahre minus 5 Tage Rand)');
  assert.ok(tail.expected_credits <= tail.status.month_left);
  // im Trial und ohne Einstellung aus
  const trial = await planner.planHistory(pool, mst, cfgFor({ ...base, trial: true }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(trial.backfill.days, 0);
  const off = await planner.planHistory(pool, mst, cfgFor({ ...base, backfillDays: 0 }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(off.backfill.days, 0);
});

test('Rückwärtsabruf: Ausführung zählt zum Monat, nicht zum Tageslimit', async () => {
  await clean();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  // Periodenende = morgen → heute ist letzter Periodentag
  const startDay = tomorrow.getUTCDate();
  if (startDay > 28) return;   // Monatsende-Klemmung: Test an diesen Tagen überspringen
  global.fetch = async (url) => {
    const p = new URL(url).searchParams;
    const day = p.get('fromdate').slice(0, 10);
    return respond(200, { status: 'success', data: [
      { time: `${day}T08:00:00Z`, lat: 43.7, lng: 7.4, speed: 0.1, course: 0 },
      { time: `${day}T20:00:00Z`, lat: 43.7, lng: 7.4, speed: 0.1, course: 0 },
    ] }, 5);
  };
  const cfg = cfgFor({ backfillDays: 365, backfillTailDays: 2, periodStartDay: startDay, historyMaxDays: 200 });
  const r = await planner.runHistory(pool, mst, cfg, { now });
  assert.ok(r.backfill_days > 0, 'Rückwärtsabruf ausgeführt');
  const kinds = await pool.query(`SELECT kind, SUM(credits)::int c FROM credit_log WHERE dataset = $1 GROUP BY kind`, [DS]);
  const byKind = Object.fromEntries(kinds.rows.map(x => [x.kind, x.c]));
  assert.ok(byKind.history_backfill > 0);
  const st = await credits.status(pool, cfg, 'myshiptracking', now);
  assert.equal(st.today_spent, byKind.history, 'Tageslimit ohne Rückwärtsabruf');
  assert.equal(st.month_spent, byKind.history + byKind.history_backfill, 'Monat mit Rückwärtsabruf');
});

// ── Datalastic (Starter 20.000, Variante B) ─────────────────────────────────
const dlCfg = (extra = {}) => ({
  ...loadConfig({ AIS_PROVIDER: 'datalastic', AIS_DATASET: DS, CREDIT_MONTH_BUDGET: '20000',
    CREDIT_DAILY_CAP: '800', POLL_HOURS_UTC: '9,21' }),
  ...extra,
});
function dlRespond(status, body, cost) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cost !== undefined) headers.set('x-request-cost', String(cost));
  return new Response(JSON.stringify(body), { status, headers });
}

test('Datalastic: Regel-Historie je Yacht ein Aufruf mit from = to, leere Tage kostenlos', async () => {
  await clean();
  const urls = [];
  global.fetch = async (url) => {
    const u = new URL(url); urls.push(u);
    const day = u.searchParams.get('from');
    const odd = Number(u.searchParams.get('imo') || u.searchParams.get('mmsi')) % 2;
    if (!odd) return dlRespond(200, { data: { positions: [] }, meta: { success: true } }, 0);   // Liegetag ohne Änderung
    return dlRespond(200, { data: { positions: [
      { lat: 43.7, lon: 7.4, speed: 0.1, course: 0, heading: 0, last_position_UTC: `${day}T20:00:00Z` },
      { lat: 43.6, lon: 7.3, speed: 11, course: 80, heading: 80, last_position_UTC: `${day}T08:00:00Z` },
    ] }, meta: { success: true } }, 2);
  };
  const cfg = dlCfg({ lookbackDays: 1 });
  const r = await planner.runHistory(pool, dl, cfg, { now: new Date('2026-11-10T03:30:00Z') });
  assert.equal(urls.length, YACHTS.length, 'ein Aufruf je Yacht');
  assert.ok(urls.every(u => u.pathname === '/api/v0/vessel_history' && u.searchParams.get('from') === '2026-11-09'
    && u.searchParams.get('to') === '2026-11-09' && u.searchParams.get('days') === null));
  assert.equal(r.days_done + r.days_empty, YACHTS.length);
  assert.ok(r.days_empty > 0 && r.days_done > 0);
  assert.equal(r.charged, r.days_done * 2, '2 Credits je Tag mit Daten');
  const moved = await pool.query(`SELECT COUNT(*)::int n FROM vessel_days WHERE dataset = $1 AND history_moved`, [DS]);
  assert.equal(moved.rows[0].n, r.days_done);
  const notes = await logRows();
  assert.ok(!notes.some(x => /Datensatzlimit/.test(x.note || '')), 'keine MST-Datensatzwarnung');
});

test('Datalastic: Rückwärtsabruf in 30-Tage-Blöcken, Fenster bis 10.08.2021', async () => {
  await clean();
  const base = { backfillDays: 5000, backfillTailDays: 2, periodStartDay: 1, backfillFrom: null };
  const tail = await planner.planHistory(pool, dl, dlCfg(base), { now: new Date('2026-11-29T03:30:00Z') });
  assert.ok(tail.backfill.days > 0, 'Rückwärtsabruf aktiv');
  assert.ok(tail.backfill.from >= '2021-08-10' && tail.backfill.from <= '2021-08-12', `ältester Tag ${tail.backfill.from}`);
  assert.ok(tail.backfill_calls.every(c => c.days.length <= 30));
  assert.ok(tail.backfill_calls.some(c => c.days.length > 1), 'mehrere Tage je Abfrage');
  const from25 = await planner.planHistory(pool, dl, dlCfg({ ...base, backfillFrom: '2025-01-01' }), { now: new Date('2026-11-29T03:30:00Z') });
  assert.equal(from25.backfill.from, '2025-01-01');
  assert.ok(tail.expected_credits <= tail.status.month_left);
});
