// Identitätsabgleich über die IMO (lib/identity.js).
// Teil 1: reine Auswertung (ohne DB). Teil 2: Lauf gegen echte PostgreSQL mit MST-Test-Double.
// Fälle nach den Befunden vom 31.10.2026: Kaos/Ulysses/Norn mit neuer MMSI, Dilbar ruhend seit
// 2023 (muss "confirmed" bleiben), alte MMSI an fremdes Schiff vergeben, IMO ohne AIS.
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/identity.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../lib/identity');

const FLEET = [
  { imo: '9661792', mmsi: '319094900', name: 'Dilbar' },
  { imo: '1012610', mmsi: '339302000', name: 'Kaos' },
  { imo: '9927940', mmsi: '319278500', name: 'Ulysses (alte MMSI)' },
  { imo: '1011850', mmsi: '319055400', name: 'Ocean Victory' },
  { imo: '9999998', mmsi: '248997000', name: 'Fremd vergeben' },
];
const RECORDS = [
  { imo: '9661792', mmsi: '319094900', name: 'DILBAR', received: '2023-11-22T09:31:00.000Z' },
  { imo: '1012610', mmsi: '538071357', name: 'KAOS', received: '2022-05-23T10:51:00.000Z' },
  { imo: '1012610', mmsi: '339302000', name: 'KAOS', received: '2026-10-30T08:00:00.000Z' },
  { imo: '9927940', mmsi: '538072099', name: 'ULYSSESS', received: '2026-09-22T23:10:00.000Z' },
  { imo: '9999998', mmsi: '248997000', name: 'X', received: '2026-10-31T10:00:00.000Z' },
];

test('Auswertung: ruhend = confirmed, neue MMSI erkannt, kein AIS, fremde MMSI', () => {
  const rows = identity.evaluate(FLEET, RECORDS, new Map([['248997000', '9123456']]));
  const by = Object.fromEntries(rows.map(r => [r.imo, r]));
  assert.equal(by['9661792'].result, 'confirmed', 'Dilbar sendet seit 2023 nicht, ist aber richtig zugeordnet');
  assert.equal(by['1012610'].result, 'confirmed', 'jüngster Datensatz entscheidet (Kaos: 339302000)');
  assert.equal(by['1012610'].n_records, 2);
  assert.equal(by['9927940'].result, 'mmsi_changed');
  assert.equal(by['9927940'].ais_mmsi, '538072099');
  assert.equal(by['1011850'].result, 'no_ais');
  assert.equal(by['9999998'].result, 'mmsi_foreign', 'extended meldet für die MMSI eine andere IMO');
});

test('Auswertung: Datensatz ohne IMO wird über eine Flotten-MMSI zugeordnet', () => {
  const rows = identity.evaluate([FLEET[0]], [{ imo: null, mmsi: '319094900', name: 'DILBAR', received: '2023-11-22T09:31:00Z' }]);
  assert.equal(rows[0].result, 'confirmed');
});

// ── Teil 2: Lauf gegen PostgreSQL (nur mit DATABASE_URL) ──────────────────────
const DB = !!process.env.DATABASE_URL;
let pool;
const DS = 'idtest';
const realFetch = global.fetch;

if (DB) {
  const { Pool } = require('pg');
  const { migrate } = require('../lib/schema');
  pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  const clean = async () => {
    for (const t of ['identity_check', 'credit_log', 'vessel_static']) await pool.query(`DELETE FROM ${t} WHERE dataset = $1`, [DS]);
  };
  before(async () => { await migrate(pool); await clean(); });
  after(async () => { global.fetch = realFetch; await clean(); await pool.end(); });

  test('Lauf: Abruf über imo-Parameter, Ergebnis gespeichert, Credits je gelieferter Yacht geloggt', async () => {
    process.env.MST_API_KEY = 'test-key'; process.env.MST_LOG_RAW = 'false';
    const mst = require('../providers/myshiptracking');
    const { loadConfig } = require('../lib/config');
    const cfg = loadConfig({ AIS_PROVIDER: 'myshiptracking', AIS_DATASET: DS, CREDIT_MONTH_BUDGET: '50000',
      CREDIT_DAILY_CAP: '1800', POLL_HOURS_UTC: 'auto' });
    await pool.query(`INSERT INTO vessel_static (dataset, mmsi, provider, imo) VALUES ($1, '248997000', 'myshiptracking', '9123456')`, [DS]);
    let seen = null;
    global.fetch = async (url) => {
      const u = new URL(url);
      seen = { imo: u.searchParams.get('imo'), mmsi: u.searchParams.get('mmsi'), response: u.searchParams.get('response') };
      const data = RECORDS.map(r => ({ vessel_name: r.name, mmsi: Number(r.mmsi), imo: Number(r.imo), vtype: 9,
        lat: 1, lng: 1, course: 0, speed: 0, nav_status: 5, received: r.received }));
      return new Response(JSON.stringify({ status: 'success', data }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-credit-charged': String(data.length) } });
    };
    const r = await identity.run(pool, mst, cfg, { yachts: FLEET, now: new Date('2026-10-31T20:00:00Z') });
    assert.equal(seen.mmsi, null, 'Abruf über IMO, nicht über MMSI');
    assert.equal(seen.imo, FLEET.map(y => y.imo).join(','));
    assert.equal(seen.response, 'simple');
    assert.deepEqual(r.summary, { confirmed: 2, mmsi_changed: 1, mmsi_foreign: 1, no_ais: 1 });
    const log = (await pool.query(`SELECT kind, credits, ids FROM credit_log WHERE dataset = $1`, [DS])).rows;
    assert.deepEqual(log, [{ kind: 'identity', credits: RECORDS.length, ids: FLEET.length }]);
    const latest = await identity.latest(pool, DS);
    assert.equal(latest.rows.length, FLEET.length);
    assert.equal(latest.rows[0].result, 'mmsi_foreign', 'Problemfälle zuerst');
    assert.equal(latest.summary.no_ais, 1);
  });

  test('Lauf: Tageslimit erschöpft → kein Abruf', async () => {
    const mst = require('../providers/myshiptracking');
    const { loadConfig } = require('../lib/config');
    const cfg = loadConfig({ AIS_PROVIDER: 'myshiptracking', AIS_DATASET: DS, CREDIT_MONTH_BUDGET: '50000',
      CREDIT_DAILY_CAP: '3', POLL_HOURS_UTC: 'auto' });
    let called = false;
    global.fetch = async () => { called = true; throw new Error('darf nicht aufgerufen werden'); };
    const r = await identity.run(pool, mst, cfg, { yachts: FLEET, now: new Date('2026-11-02T20:00:00Z') });
    assert.equal(r.skipped, 'Budget/Tageslimit');
    assert.equal(called, false);
  });
}
