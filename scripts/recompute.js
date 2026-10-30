#!/usr/bin/env node
// ── Neuberechnung gespeicherter Messpunkte mit der aktuellen Emissionsberechnung ──
// Rohdaten (SOG, nav_status, Hafeninfo) bleiben unverändert; neu berechnet werden die Raten
// (co2/nox/sox/fuel_kg_h) und die v3-Zusatzspalten. Grundlage sind die Stammdaten in fleet.js.
//
// Aufruf (Railway-Shell oder lokal mit DATABASE_URL):
//   node scripts/recompute.js               nur Zeilen mit anderer calc_version (Standard)
//   node scripts/recompute.js --all         alle Zeilen (z. B. nach Änderung der Stammdaten)
//   node scripts/recompute.js --dry-run     nur zählen und Summen vergleichen, nichts schreiben
//   Optionen: --dataset prod|trial|mock  --batch 2000
// Grenzen: Tiefgang wird pro Messpunkt nicht gespeichert → Tiefgangsfaktor = 1. Die Historie liefert
// keinen nav_status und keine Hafeninfo → liegende Punkte gelten dort als „vor Anker“ (kein Landstrom).
const { calcHourlyEmissions, CALC_VERSION } = require('../emissions');
const { byMmsi } = require('../fleet');

function parseArgs(argv) {
  const o = { all: false, dryRun: false, dataset: null, batch: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--dataset') o.dataset = argv[++i];
    else if (a === '--batch') o.batch = Math.max(100, Number(argv[++i]) || 2000);
    else throw new Error(`Unbekannte Option: ${a}`);
  }
  return o;
}

// Reine Rechnung je Zeile (ohne Datenbank, testbar)
function recomputeRow(row) {
  const y = byMmsi.get(String(row.mmsi));
  if (!y) return null;
  const nav = row.nav_status === null || row.nav_status === undefined ? null : Number(row.nav_status);
  return calcHourlyEmissions(y, Number(row.speed_knots) || 0, nav, { atPort: row.current_port ? true : undefined });
}

async function recompute(pool, opts = {}) {
  const o = { all: false, dryRun: false, dataset: null, batch: 2000, log: console.log, ...opts };
  const stats = { version: CALC_VERSION, scanned: 0, updated: 0, skipped_unknown_mmsi: 0,
                  co2_rate_sum_before: 0, co2_rate_sum_after: 0, dry_run: o.dryRun };
  let lastId = 0;
  for (;;) {
    const cond = ['id > $1'];
    const params = [lastId];
    if (!o.all) { params.push(CALC_VERSION); cond.push(`calc_version IS DISTINCT FROM $${params.length}`); }
    if (o.dataset) { params.push(o.dataset); cond.push(`dataset = $${params.length}`); }
    params.push(o.batch);
    const { rows } = await pool.query(
      `SELECT id, mmsi, speed_knots, nav_status, current_port, co2_kg_h
         FROM positions WHERE ${cond.join(' AND ')} ORDER BY id LIMIT $${params.length}`, params);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;
    stats.scanned += rows.length;

    const u = { id: [], co2: [], nox: [], sox: [], fuel: [], load: [], mcr: [], mcrEst: [], phase: [],
                pMain: [], pHotel: [], fMain: [], fHotel: [], grid: [] };
    for (const r of rows) {
      const em = recomputeRow(r);
      if (!em) { stats.skipped_unknown_mmsi++; continue; }
      stats.co2_rate_sum_before += Number(r.co2_kg_h) || 0;
      stats.co2_rate_sum_after += em.co2_kg_h;
      u.id.push(r.id); u.co2.push(em.co2_kg_h); u.nox.push(em.nox_kg_h); u.sox.push(em.sox_kg_h);
      u.fuel.push(em.fuel_kg_h); u.load.push(em.me_load); u.mcr.push(em.mcr_kw); u.mcrEst.push(em.mcr_estimated);
      u.phase.push(em.phase); u.pMain.push(em.p_main_kw); u.pHotel.push(em.p_hotel_kw);
      u.fMain.push(em.fuel_main_kg_h); u.fHotel.push(em.fuel_hotel_kg_h); u.grid.push(em.co2_grid_kg_h);
    }
    if (!o.dryRun && u.id.length) {
      const res = await pool.query(`
        UPDATE positions p SET
          co2_kg_h = v.co2, nox_kg_h = v.nox, sox_kg_h = v.sox, fuel_kg_h = v.fuel,
          me_load = v.load, mcr_kw = v.mcr, mcr_estimated = v.mcr_est, calc_version = $15,
          phase = v.phase, p_main_kw = v.p_main, p_hotel_kw = v.p_hotel,
          fuel_main_kg_h = v.f_main, fuel_hotel_kg_h = v.f_hotel, co2_grid_kg_h = v.grid
        FROM unnest($1::int[], $2::float8[], $3::float8[], $4::float8[], $5::float8[], $6::float8[],
                    $7::float8[], $8::bool[], $9::text[], $10::float8[], $11::float8[], $12::float8[],
                    $13::float8[], $14::float8[])
             AS v(id, co2, nox, sox, fuel, load, mcr, mcr_est, phase, p_main, p_hotel, f_main, f_hotel, grid)
        WHERE p.id = v.id`,
      [u.id, u.co2, u.nox, u.sox, u.fuel, u.load, u.mcr, u.mcrEst, u.phase, u.pMain, u.pHotel,
       u.fMain, u.fHotel, u.grid, CALC_VERSION]);
      stats.updated += res.rowCount;
    }
    o.log(`[recompute] bis id ${lastId}: gelesen ${stats.scanned}, geschrieben ${stats.updated}`);
  }
  return stats;
}

module.exports = { recompute, recomputeRow, parseArgs };

if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
    try {
      const stats = await recompute(pool, opts);
      console.log(JSON.stringify(stats, null, 2));
      console.log('Hinweis: Das Dashboard cached Summen 60 s; danach sind die neuen Werte sichtbar.');
    } finally { await pool.end(); }
  })().catch(err => { console.error('[recompute] Fehler:', err.message); process.exit(1); });
}
