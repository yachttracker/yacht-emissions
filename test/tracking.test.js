// Tracking-Zustand (lib/tracking.js) und seine Wirkung auf die Abruflogik.
// Teil 1 ohne DB: Prüfung der CSV. Teil 2 gegen PostgreSQL: pausierte Yacht wird nicht abgerufen,
// Lebenszeichen im IMO-Abgleich → automatisch wieder aktiv + Historie nachgekauft, Prüfliste.
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/tracking.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tracking = require('../lib/tracking');
const { YACHTS } = require('../fleet');

const DILBAR = YACHTS.find(y => y.imo === '9661792');
const HEAD = 'imo;name;reason;since;last_seen;next_check;source_url;note';
const row = (o = {}) => ({ imo: '9661792', name: 'Dilbar', reason: 'seized', since: '2026-11-01',
  last_seen: '2023-11-22T09:31:48Z', next_check: '2026-12-01',
  source_url: 'https://www.themoscowtimes.com/2026/06/30/german-court-rules-eu-sanctions-no-longer-apply-to-superyacht-linked-to-usmanov-a93129', note: '', ...o });
function csv(rows) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trk-')), 'tracking_state.csv');
  fs.writeFileSync(f, ['# Test', HEAD, ...rows.map(r => Object.values(r).join(';'))].join('\n'));
  return f;
}

test('CSV: gültige Pause wird der Flotten-MMSI zugeordnet', () => {
  const rows = tracking.loadStateCsv(csv([row()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mmsi, DILBAR.mmsi);
});
test('CSV: Pause ohne Quelle, mit unbekanntem Grund oder fremder IMO wird abgelehnt', () => {
  assert.throws(() => tracking.loadStateCsv(csv([row({ source_url: '' })])), /source_url/);
  assert.throws(() => tracking.loadStateCsv(csv([row({ reason: 'urlaub' })])), /reason/);
  assert.throws(() => tracking.loadStateCsv(csv([row({ imo: '1234567' })])), /nicht in der Flotte/);
  assert.throws(() => tracking.loadStateCsv(csv([row(), row()])), /doppelt/);
});
test('CSV im Repo ist gültig', () => {
  assert.doesNotThrow(() => tracking.loadStateCsv());
});

const DB = !!process.env.DATABASE_URL;
if (DB) {
  const { Pool } = require('pg');
  const { migrate } = require('../lib/schema');
  const { loadConfig } = require('../lib/config');
  const planner = require('../lib/planner');
  const identity = require('../lib/identity');
  const mst = require('../providers/myshiptracking');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  const DS = 'trtest';
  const realFetch = global.fetch;
  process.env.MST_API_KEY = 'test-key'; process.env.MST_LOG_RAW = 'false';
  const cfg = loadConfig({ AIS_PROVIDER: 'myshiptracking', AIS_DATASET: DS, CREDIT_MONTH_BUDGET: '50000',
    CREDIT_DAILY_CAP: '1800', POLL_HOURS_UTC: 'auto' });
  const clean = async () => {
    for (const t of ['positions', 'vessel_days', 'credit_log', 'vessel_static', 'identity_check', 'tracking_resume']) {
      await pool.query(`DELETE FROM ${t} WHERE dataset = $1`, [DS]);
    }
  };
  before(async () => { await migrate(pool); await clean(); tracking.setStateForTest(tracking.loadStateCsv(csv([row()]))); });
  after(async () => { global.fetch = realFetch; tracking.setStateForTest([]); await clean(); await pool.end(); });

  test('pausierte Yacht: kein Live-Abruf, keine Historie', async () => {
    let asked = [];
    global.fetch = async (url) => {
      asked = asked.concat(new URL(url).searchParams.get('mmsi').split(','));
      return new Response(JSON.stringify({ status: 'success', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await planner.pollLive(pool, mst, cfg, { now: new Date('2026-11-02T13:07:00Z') });
    assert.equal(asked.length, YACHTS.length - 1);
    assert.ok(!asked.includes(DILBAR.mmsi), 'Dilbar darf nicht abgefragt werden');
    const cands = await planner.buildHistoryCandidates(pool, cfg, { now: new Date('2026-11-02T03:23:00Z') });
    assert.ok(cands.length > 0);
    assert.ok(!cands.some(c => c.mmsi === DILBAR.mmsi), 'keine Historie für Dilbar');
  });

  test('Lebenszeichen im IMO-Abgleich → wieder aktiv, Historie ab Meldung nachgekauft, Prüfliste meldet es', async () => {
    const now = new Date('2026-11-06T02:41:00Z');
    global.fetch = async () => new Response(JSON.stringify({ status: 'success', data: [
      { vessel_name: 'DILBAR', mmsi: Number(DILBAR.mmsi), imo: 9661792, lat: 53.5, lng: 9.9, speed: 9, received: '2026-10-30T10:00:00Z' }] }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-credit-charged': '1' } });
    const r = await identity.run(pool, mst, cfg, { yachts: [DILBAR], now });
    assert.equal(r.resumed.length, 1);
    assert.equal(r.resumed[0].backfill_from, '2026-10-30');
    assert.equal((await tracking.paused(pool, DS)).size, 0, 'nicht mehr pausiert');

    const cands = await planner.buildHistoryCandidates(pool, cfg, { now });
    const d = cands.filter(c => c.mmsi === DILBAR.mmsi).map(c => `${c.day}:${c.prio}:${c.why}`).sort();
    assert.ok(d.includes('2026-10-30:1:Wiederaufnahme nach Pause'), 'Tag der Meldung wird nachgekauft');
    assert.ok(d.includes('2026-11-02:1:Wiederaufnahme nach Pause'));
    assert.ok(d.some(x => x.startsWith('2026-11-05:')), 'normale Lookback-Tage weiter enthalten');

    const rev = await tracking.review(pool, DS, { now, identityLatest: await identity.latest(pool, DS) });
    assert.ok(rev.items.some(i => i.imo === '9661792' && i.issue === 'resumed'), 'Pause-Eintrag zum Entfernen gemeldet');
  });

  test('ältere Meldung als last_seen → bleibt pausiert', async () => {
    await clean();
    global.fetch = async () => new Response(JSON.stringify({ status: 'success', data: [
      { vessel_name: 'DILBAR', mmsi: Number(DILBAR.mmsi), imo: 9661792, lat: 53.17, lng: -8.59, speed: 0, received: '2023-11-22T09:31:48Z' }] }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-credit-charged': '1' } });
    const r = await identity.run(pool, mst, cfg, { yachts: [DILBAR], now: new Date('2026-11-06T02:41:00Z') });
    assert.equal(r.resumed.length, 0);
    assert.equal((await tracking.paused(pool, DS)).size, 1);
    const rev = await tracking.review(pool, DS, { now: new Date('2026-12-02T00:00:00Z') });
    assert.ok(rev.items.some(i => i.imo === '9661792' && i.issue === 'pause_due'), 'Wiedervorlage fällig');
    assert.ok(!rev.items.some(i => i.imo === '9661792' && i.issue === 'no_data'), 'pausiert → kein „keine Daten“-Eintrag');
  });
}
