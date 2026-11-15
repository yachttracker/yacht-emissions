// Liegezustände in der Zeitintegration (lib/integrate.js, Regel Paul 2026-11-15) gegen eine echte
// PostgreSQL. Fälle und Erwartungen: test/stays.fixtures.js (von Hand nachrechenbar).
// Eigener Datensatz 'sttest', wird vorher und nachher gelöscht.
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/stays.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { migrate } = require('../lib/schema');
const { integrateEmissions, stayParams, stayMeta } = require('../lib/integrate');
const { loadZones, loadZoneCsv } = require('../lib/zones');
const tracking = require('../lib/tracking');
const { SCENARIOS, ZONES, PARAMS, NOW } = require('./stays.fixtures');

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
const DS = 'sttest';
const MMSIS = SCENARIOS.map(s => s.mmsi);
const EVIDENCE = SCENARIOS.filter(s => s.since).map(s => ({ mmsi: s.mmsi, imo: s.imo, since: s.since }));

async function clean() {
  await pool.query(`DELETE FROM positions WHERE dataset = $1`, [DS]);
  await pool.query(`DELETE FROM vessel_days WHERE dataset = $1`, [DS]);
}

before(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY, mmsi TEXT NOT NULL, name TEXT, owner TEXT, flag TEXT, length_m DOUBLE PRECISION,
    latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, speed_knots DOUBLE PRECISION, heading INTEGER,
    nav_status TEXT, co2_kg_h DOUBLE PRECISION, nox_kg_h DOUBLE PRECISION, sox_kg_h DOUBLE PRECISION,
    fuel_kg_h DOUBLE PRECISION, timestamp TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS me_load DOUBLE PRECISION;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS mcr_kw DOUBLE PRECISION;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS mcr_estimated BOOLEAN;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS calc_version TEXT;`);
  await migrate(pool);
  await clean();
  for (const s of SCENARIOS) {
    for (const p of s.points) {
      await pool.query(`INSERT INTO positions (mmsi, name, latitude, longitude, speed_knots, co2_kg_h, nox_kg_h,
                          sox_kg_h, fuel_kg_h, timestamp, source, dataset)
                        VALUES ($1, $2, $3, $4, $5, $6::float8, $6::float8 / 30, $6::float8 / 300, $6::float8 / 3.206, $7, $8, $9)`,
      [s.mmsi, s.id, p.lat, p.lon, p.sog, p.co2, p.ts, p.source, DS]);
    }
    for (const [d, status, liveHits = 0] of s.days || []) {
      await pool.query(`INSERT INTO vessel_days (dataset, mmsi, day, history_status, live_hits)
                        VALUES ($1, $2, $3::date, $4, $5)`, [DS, s.mmsi, d, status, liveHits]);
    }
  }
});

after(async () => { await clean(); await pool.end(); });

const run = (win) => integrateEmissions(pool, { t0: new Date(win.t0), t1: new Date(win.t1),
  period_h: (Date.parse(win.t1) - Date.parse(win.t0)) / 3600000 },
{ dataset: DS, params: PARAMS, zones: ZONES, evidence: EVIDENCE, fleetMmsi: MMSIS, now: new Date(NOW) });

for (const s of SCENARIOS) {
  test(`${s.id}: ${s.title}`, async () => {
    const rows = await run(s.win);
    const r = rows.find(x => x.mmsi === s.mmsi);
    assert.ok(r, `${s.id}: keine Zeile im Fenster`);
    for (const [k, v] of Object.entries(s.expect)) {
      assert.ok(Math.abs(Number(r[k]) - v) <= 0.05, `${s.id} ${k}: ${r[k]} statt ${v}`);
    }
    if (s.alsoAbsentIn) {
      const other = await run(s.alsoAbsentIn);
      assert.ok(!other.some(x => x.mmsi === s.mmsi), `${s.id}: darf im Fenster ${s.alsoAbsentIn.t0} nicht auftauchen`);
    }
  });
}

test('Obergrenze STAY_MAX_BRIDGE_DAYS kappt lange Überbrückungen', async () => {
  const s = SCENARIOS.find(x => x.id === 'S2');
  const rows = await integrateEmissions(pool, { t0: new Date(s.win.t0), t1: new Date(s.win.t1), period_h: 720 },
    { dataset: DS, params: { ...PARAMS, maxBridgeDays: 5 }, zones: ZONES, evidence: EVIDENCE, fleetMmsi: MMSIS,
      now: new Date(NOW) });
  assert.ok(!rows.some(x => x.mmsi === s.mmsi), 'Lay-up seit 20.11. reicht mit 5 Tagen nicht in den Dezember');
});

test('ohne Zonen und ohne Beleg: Hafen = Anker, Lay-up nur über die Stille nicht erkennbar', async () => {
  const s = SCENARIOS.find(x => x.id === 'S4');
  const rows = await integrateEmissions(pool, { t0: new Date(s.win.t0), t1: new Date(s.win.t1), period_h: 720 },
    { dataset: DS, params: PARAMS, zones: [], evidence: [], fleetMmsi: MMSIS, now: new Date(NOW) });
  const r = rows.find(x => x.mmsi === s.mmsi);
  assert.equal(r.coverage_layup_h, 0);
  assert.equal(r.coverage_h, 24, 'Anker im Live-Betrieb: höchstens 24 h ohne Meldung');
  assert.equal(r.co2_kg_total, 720);
});

test('Parameter, Metadaten und CSV-Prüfung', () => {
  const p = stayParams({});
  assert.equal(p.silentMinDays, 30);
  assert.equal(p.yardMinHours, 72);
  assert.equal(p.stationaryMaxGapHours, 24);
  assert.equal(p.liveSince.toISOString(), '2026-11-12T00:00:00.000Z');
  assert.throws(() => stayParams({ LIVE_SINCE: 'gestern' }));
  const m = stayMeta(p, ZONES);
  assert.equal(m.zones_ports, 1);
  assert.equal(m.zones_yards, 1);
  assert.deepEqual(loadZones().length >= 0, true, 'data/ports.csv und data/yards.csv sind lesbar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zones-'));
  const f = path.join(dir, 'ports.csv');
  fs.writeFileSync(f, 'name;lat;lon;radius_sm;source_url;note\nTest;43.5;7.1;0.5;;ohne Quelle\n');
  assert.throws(() => loadZoneCsv(f, 'port'), /source_url/);
  fs.writeFileSync(f, 'name;lat;lon;radius_sm;source_url;note\nTest;93.5;7.1;0.5;https://example.org;\n');
  assert.throws(() => loadZoneCsv(f, 'port'), /lat/);
  fs.writeFileSync(f, 'name;lat;lon;radius_sm;source_url;note\nTest;43.5;7.1;0.5;https://example.org;\n');
  assert.equal(loadZoneCsv(f, 'port')[0].radius_sm, 0.5);
});

test('Beleg aus tracking_state.csv: nur Pausen wegen refit/seized/laid_up', () => {
  const rows = [
    { imo: '1', mmsi: '1', action: 'pause', reason: 'laid_up', since: '2026-12-01' },
    { imo: '2', mmsi: '2', action: 'pause', reason: 'ais_off', since: '2026-12-01' },
    { imo: '3', mmsi: '3', action: 'watch', reason: 'refit', since: '2026-12-01' },
    { imo: '4', mmsi: '4', action: 'pause', reason: 'refit', since: '2026-12-02' },
  ];
  assert.deepEqual(tracking.layupEvidence(rows).map(e => e.mmsi), ['1', '4']);
});

test('Liegeorte (/api/stays): Episoden ≥ 72 h nach Ort zusammengefasst, Zonen erkannt', async () => {
  const { listStays } = require('../lib/staylist');
  const places = await listStays(pool, { dataset: DS, zones: ZONES, minHours: 72, now: new Date(NOW) });
  const byZone = (k) => places.find(p => p.zone && p.zone.kind === k);
  const names = (p) => p.yachts.map(y => y.name).sort();
  const port = byZone('port');
  assert.ok(port, 'Hafen gefunden');
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S10']) assert.ok(names(port).includes(id), `${id} im Hafen`);
  assert.ok(port.open_now.some(o => o.name === 'S2'), 'S2 schweigt seit 20.11. (offen)');
  const yard = byZone('yard');
  assert.deepEqual(names(yard), ['S12', 'S5'], 'Werft: S5 und S12; S6 nur 48 h → nicht aufgeführt');
  const anchor = places.find(p => !p.zone && names(p).includes('S11'));
  assert.ok(anchor, 'Ankerplatz ohne Zone');
  for (const id of ['S7', 'S8', 'S9']) assert.ok(names(anchor).includes(id), `${id} vor Anker`);
  assert.ok(anchor.radius_sm_suggested >= 0.3);
  assert.match(anchor.csv, /^;\d+\.\d{4};\d+\.\d{4};\d+(\.\d)?;;$/);
});
