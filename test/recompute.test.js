// Test für scripts/recompute.js gegen eine echte PostgreSQL (Schema muss angelegt sein, z. B. durch
// einen Serverstart). Eigener Datensatz 'rctest', wird vorher und nachher gelöscht.
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/recompute.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { recompute } = require('../scripts/recompute');
const { calcHourlyEmissions, CALC_VERSION } = require('../emissions');
const { byMmsi } = require('../fleet');

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
const DS = 'rctest';
const KORU = '319225400', LAUNCHPAD = '538072122', UNKNOWN = '999999999';

before(async () => {
  await pool.query(`DELETE FROM positions WHERE dataset = $1`, [DS]);
  const rows = [
    [KORU, 12, null, null, '2026-10-01T10:00:00Z'],
    [KORU, 0.2, '5', 'Monaco', '2026-10-01T11:00:00Z'],
    [LAUNCHPAD, 0.5, '1', null, '2026-10-01T10:00:00Z'],
    [LAUNCHPAD, 15, '0', null, '2026-10-01T11:00:00Z'],
    [UNKNOWN, 10, null, null, '2026-10-01T10:00:00Z'],
  ];
  for (const [mmsi, sog, nav, port, ts] of rows) {
    await pool.query(`
      INSERT INTO positions (mmsi, name, latitude, longitude, speed_knots, nav_status, current_port,
                             co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp, calc_version, source, dataset)
      VALUES ($1,'t',43.7,7.4,$2,$3,$4, 1,1,1,1, $5, '2026-10-15-v2', 'history', $6)`,
    [mmsi, sog, nav, port, ts, DS]);
  }
});

after(async () => {
  await pool.query(`DELETE FROM positions WHERE dataset = $1`, [DS]);
  await pool.end();
});

test('Probelauf schreibt nichts', async () => {
  const s = await recompute(pool, { dataset: DS, dryRun: true, log: () => {} });
  assert.equal(s.scanned, 5);
  assert.equal(s.updated, 0);
  assert.equal(s.skipped_unknown_mmsi, 1);
  const { rows } = await pool.query(`SELECT count(*)::int n FROM positions WHERE dataset=$1 AND calc_version=$2`, [DS, CALC_VERSION]);
  assert.equal(rows[0].n, 0);
});

test('Neuberechnung setzt v3-Werte identisch zur Funktion', async () => {
  const s = await recompute(pool, { dataset: DS, batch: 100, log: () => {} });
  assert.equal(s.updated, 4);
  const { rows } = await pool.query(`SELECT * FROM positions WHERE dataset=$1 ORDER BY mmsi, timestamp`, [DS]);
  for (const r of rows) {
    if (r.mmsi === UNKNOWN) { assert.equal(r.calc_version, '2026-10-15-v2'); continue; }
    const em = calcHourlyEmissions(byMmsi.get(r.mmsi), r.speed_knots,
      r.nav_status === null ? null : Number(r.nav_status), { atPort: r.current_port ? true : undefined });
    assert.equal(r.calc_version, CALC_VERSION);
    assert.ok(Math.abs(r.co2_kg_h - em.co2_kg_h) < 1e-6, `co2 ${r.mmsi}`);
    assert.ok(Math.abs(r.p_hotel_kw - em.p_hotel_kw) < 1e-6, `p_hotel ${r.mmsi}`);
    assert.equal(r.phase, em.phase);
  }
  const phases = rows.filter(r => r.mmsi !== UNKNOWN).map(r => r.phase).sort();
  assert.deepEqual(phases, ['anchor', 'berth', 'underway', 'underway']);
});

test('Zweiter Lauf ohne --all findet nichts mehr (idempotent)', async () => {
  const s = await recompute(pool, { dataset: DS, log: () => {} });
  assert.equal(s.updated, 0);
  assert.equal(s.scanned, 1); // nur die unbekannte MMSI bleibt auf alter Version
});
