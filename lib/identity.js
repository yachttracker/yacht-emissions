// ── Identitätsabgleich über die IMO (Konzept 2026-10-31) ─────────────────────
// Die IMO-Nummer bleibt ein Schiffsleben lang gleich; MMSI, Name und Flagge wechseln (Flaggen-
// wechsel → neue MMSI). Vier Yachten der Flotte liefen am 31.10.2026 unter veralteter MMSI, obwohl
// zwei Recherchen sie "bestätigt" hatten: geprüft wurde Stimmigkeit gegen Aggregatoren, nicht ob
// unter der MMSI noch gesendet wird. Dieser Abgleich fragt MST deshalb direkt über die IMO.
//
// Prüfungen je Yacht:
//   A  Abruf über die IMO → MMSI des jüngsten Datensatzes vs. MMSI der Flotte
//   B  Rückprüfung: IMO, die der extended-Abruf für die genutzte MMSI meldet (vessel_static,
//      kostenlos, schon bezahlt) – erkennt eine alte MMSI, die an ein anderes Schiff ging
// Ergebnis (result):
//   confirmed     MST führt die IMO unter unserer MMSI (egal wie alt die letzte Meldung ist:
//                 eine ruhende Yacht wie Dilbar ist richtig zugeordnet und bleibt getrackt)
//   mmsi_changed  MST führt die IMO unter einer anderen MMSI → Prüfliste, Freigabe durch Paul
//   mmsi_foreign  extended meldet für unsere MMSI eine andere IMO → Daten gehören nicht zur Yacht
//   no_ais        MST kennt zu der IMO keinen Datensatz (AIS aus, außerhalb der Abdeckung,
//                 oder MST führt die IMO nicht) → Prüfliste, Web-Recherche
// Kosten: 1 Credit je gelieferter Yacht, leere Antworten kostenlos (belegt: MST Bulk-Doku).
// Ungeklärt bis zum ersten Lauf: ob MST zu einer IMO die aktuelle MMSI liefert.

const credits = require('./credits');
const tracking = require('./tracking');

const RESULTS = ['confirmed', 'mmsi_changed', 'mmsi_foreign', 'no_ais'];

// Reine Auswertung (ohne DB/Netz), damit sie direkt testbar ist.
// yachts: [{ imo, mmsi, name }], records: MST-Datensätze, staticImo: Map fleet_mmsi → imo
function evaluate(yachts, records, staticImo = new Map()) {
  const imoOfMmsi = new Map(yachts.map(y => [String(y.mmsi), String(y.imo)]));
  const byImo = new Map();
  for (const r of records) {
    // Fehlt die IMO im Datensatz, über die MMSI zuordnen (nur wenn sie eindeutig zur Flotte gehört)
    const imo = r.imo || (r.mmsi && imoOfMmsi.get(String(r.mmsi))) || null;
    if (!imo) continue;
    if (!byImo.has(imo)) byImo.set(imo, []);
    byImo.get(imo).push(r);
  }
  return yachts.map(y => {
    const imo = String(y.imo);
    const recs = (byImo.get(imo) || []).slice()
      .sort((a, b) => (Date.parse(b.received || 0) || 0) - (Date.parse(a.received || 0) || 0));
    const top = recs[0] || null;
    const sImo = staticImo.get(String(y.mmsi)) || null;
    let result;
    if (sImo && sImo !== imo) result = 'mmsi_foreign';
    else if (!top) result = 'no_ais';
    else if (String(top.mmsi) === String(y.mmsi)) result = 'confirmed';
    else result = 'mmsi_changed';
    return {
      imo, name: y.name, fleet_mmsi: String(y.mmsi),
      ais_mmsi: top ? String(top.mmsi) : null, ais_name: top ? top.name : null,
      ais_received: top ? top.received : null, n_records: recs.length,
      records: recs.map(r => ({ mmsi: r.mmsi, name: r.name, received: r.received })),
      static_imo: sImo, result,
    };
  });
}

async function staticImoMap(pool, dataset) {
  const r = await pool.query(
    `SELECT DISTINCT ON (mmsi) mmsi, imo FROM vessel_static
      WHERE dataset = $1 AND imo IS NOT NULL ORDER BY mmsi, fetched_at DESC`, [dataset]);
  return new Map(r.rows.map(x => [String(x.mmsi), String(x.imo)]));
}

async function run(pool, provider, cfg, { yachts, now = new Date(), ...opts } = {}) {
  if (typeof provider.fetchByImo !== 'function') return { skipped: `Anbieter ${provider.name} ohne IMO-Abruf` };
  const list = yachts.filter(y => y.imo && /^\d{7}$/.test(String(y.imo)));
  const imos = list.map(y => String(y.imo));
  const expected = imos.length * provider.COSTS.live_simple;   // Obergrenze: 1 Credit je gelieferter Yacht

  if (cfg.dryRun) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'identity', ids: imos.length,
      credits: 0, expected, dry_run: true, note: 'dry-run' });
    return { dry_run: true, expected };
  }
  const st = await credits.status(pool, cfg, provider.name, now);
  if (!credits.canSpend(st, expected)) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'identity', ids: imos.length,
      credits: 0, expected, note: 'übersprungen: Budget/Tageslimit' });
    return { skipped: 'Budget/Tageslimit', expected };
  }

  let res;
  try {
    res = await provider.fetchByImo(imos);
  } catch (e) {
    for (const c of e.calls || [{ ids: imos.length, charged: e.charged || 0, status: e.status, error: e.message }]) {
      await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'identity', ids: c.ids,
        credits: c.charged || 0, expected: c.ids, http_status: c.status ?? null, note: String(c.error).slice(0, 250) });
    }
    throw e;
  }
  for (const c of res.calls) {
    const notes = [];
    if (c.error) notes.push(String(c.error).slice(0, 250));
    if (c.estimated) notes.push('X-Credit-Charged fehlt, aus Antwort geschätzt');
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'identity', ids: c.ids,
      credits: c.charged || 0, expected: c.ids, http_status: c.status ?? null, note: notes.join('; ') || null });
  }

  const rows = evaluate(list, res.records, await staticImoMap(pool, cfg.dataset));
  const runAt = now.toISOString();
  for (const r of rows) {
    await pool.query(`
      INSERT INTO identity_check (dataset, run_at, imo, name, fleet_mmsi, ais_mmsi, ais_name, ais_received,
                                  n_records, records, static_imo, result)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (dataset, run_at, imo) DO NOTHING`,
    [cfg.dataset, runAt, r.imo, r.name, r.fleet_mmsi, r.ais_mmsi, r.ais_name, r.ais_received,
     r.n_records, JSON.stringify(r.records), r.static_imo, r.result]);
  }
  const summary = Object.fromEntries(RESULTS.map(k => [k, rows.filter(r => r.result === k).length]));
  // Lebenszeichen pausierter Yachten: jüngere Meldung als last_seen → automatisch wieder aktiv
  const resumed = await tracking.resumeFromIdentity(pool, cfg.dataset, rows, { now, rows: opts.trackingRows });
  return { run_at: runAt, checked: rows.length, charged: res.charged, summary, resumed };
}

// Letzter Lauf (öffentlich lesbar: nur IMO, MMSI, Namen und Empfangszeit, keine Eigentümer)
async function latest(pool, dataset) {
  const last = await pool.query(`SELECT MAX(run_at) AS t FROM identity_check WHERE dataset = $1`, [dataset]);
  const t = last.rows[0].t;
  if (!t) return { dataset, run_at: null, summary: null, rows: [] };
  const r = await pool.query(`
    SELECT imo, name, fleet_mmsi, ais_mmsi, ais_name, ais_received, n_records, records, static_imo, result
      FROM identity_check WHERE dataset = $1 AND run_at = $2
     ORDER BY CASE result WHEN 'mmsi_foreign' THEN 0 WHEN 'mmsi_changed' THEN 1 WHEN 'no_ais' THEN 2 ELSE 3 END,
              ais_received NULLS FIRST`, [dataset, t]);
  const summary = Object.fromEntries(RESULTS.map(k => [k, r.rows.filter(x => x.result === k).length]));
  return { dataset, run_at: t, summary, rows: r.rows };
}

async function lastRunAt(pool, dataset) {
  const r = await pool.query(`SELECT MAX(run_at) AS t FROM identity_check WHERE dataset = $1`, [dataset]);
  return r.rows[0].t ? new Date(r.rows[0].t) : null;
}

module.exports = { evaluate, run, latest, lastRunAt, RESULTS };
