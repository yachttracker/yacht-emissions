// ── Zeitintegration mit Liegezuständen (Regel Paul, 2026-11-15) ──────────────────────
// Menge = Σ Rate_i × Dauer_i × Faktor_i. Jede Meldung liefert eine Rate (kg/h, emissions.js);
// sie gilt ab ihrem Zeitstempel bis zur nächsten Meldung derselben Yacht, höchstens aber
// MAX_GAP_HOURS (live) bzw. MAX_GAP_HOURS_HISTORY (Historie). Längere Lücken zählen nicht als
// Emission, sondern als "nicht abgedeckt" (coverage_h). Je (Yacht, UTC-Tag) mit Historie
// (vessel_days.history_status = 'done') zählen nur die Historienpunkte.
//
// Liegezustände (Annahmen, mit Prof. Baumann abzustimmen):
//   Halt      = Meldung langsamer als STATIONARY_V_KN; liegt die nächste Meldung am selben Ort
//               (≤ STATIONARY_DIST_SM), war die Yacht in der Lücke dort (Liegezeit).
//   Episode   = aufeinanderfolgende Halte am selben Ort ("gaps and islands").
//   Ort       = Werft (data/yards.csv), Hafen (data/ports.csv), sonst Anker.
//   Zustand   = belegtes Lay-up (data/tracking_state.csv: Pause wegen refit/seized/laid_up)
//             > Werft, wenn die Episode ≥ STAY_YARD_MIN_HOURS dauert (0 Emissionen, AIS egal)
//             > Hafen, AIS seit ≥ STAY_SILENT_MIN_DAYS stumm (nur im Live-Betrieb ab LIVE_SINCE
//               messbar): Lay-up ab der letzten Meldung (Notstrom ≈ 0), als unbestätigt ausgewiesen
//             > Hafen sonst bzw. Anker: Hotelbetrieb (Generatoren; Landstrom nicht angesetzt)
//   Überbrückt wird eine Liegezeit nur, wenn die Lücke beobachtet ist: jeder volle Tag dazwischen
//   hat eine gekaufte Historie (empty/done; Datalastic liefert nur Positionsänderungen) oder liegt
//   im Live-Betrieb (≥ LIVE_SINCE, Abruf 2×/Tag). Sonst wie bisher höchstens
//   STATIONARY_MAX_GAP_HOURS (Regel A32 vom 07.11.). Vor Anker gilt im Live-Betrieb dieselbe
//   Grenze, weil das AIS dort Pflicht ist (IMO A.1106(29)) – eine längere Stille ist eine Datenlücke.
//   Das gilt auch zwischen Historienpunkten (P-05, 15.11.): Ab LIVE_SINCE wird eine Anker-Lücke nur
//   überbrückt, wenn jeder volle Tag dazwischen eine frische Live-Meldung (vessel_days.live_hits > 0)
//   oder einen Historientag mit Daten hat. Leere Historie allein heißt "nicht bewegt" oder "stumm".
//   Für Tage vor LIVE_SINCE ist Stille nicht erkennbar: dort zählt der Hafen als Hotelbetrieb.

const hav = (la1, lo1, la2, lo2) => `(2 * 3440.065 * ASIN(LEAST(1, SQRT(
      POWER(SIN(RADIANS(${la2} - ${la1}) / 2), 2)
      + COS(RADIANS(${la1})) * COS(RADIANS(${la2})) * POWER(SIN(RADIANS(${lo2} - ${lo1}) / 2), 2)))))`;

// Vorrang der Historie: an Tagen mit Historie zählen keine Live-Punkte
const usable = (a) => `${a}.source IN ('live', 'history')
        AND (${a}.source = 'history' OR NOT EXISTS (
              SELECT 1 FROM vessel_days v
               WHERE v.dataset = ${a}.dataset AND v.mmsi = ${a}.mmsi
                 AND v.day = (${a}.timestamp AT TIME ZONE 'UTC')::date
                 AND v.history_status = 'done'))`;

const SQL = `
    WITH bounds AS (
      SELECT $1::timestamptz                       AS t0,
             $2::timestamptz                       AS t1,
             $22::timestamptz                      AS now_ts,
             make_interval(hours => $5)            AS max_gap,
             make_interval(hours => $6)            AS max_gap_hist,
             make_interval(hours => $7)            AS max_gap_stat,
             $8::float8                            AS stat_v,
             $9::float8                            AS stat_d,
             make_interval(hours => $10)           AS yard_min,
             make_interval(days => $11)            AS silent_min,
             $12::timestamptz                      AS live_since,
             ($12::timestamptz AT TIME ZONE 'UTC')::date AS live_since_day,
             make_interval(days => $21)            AS max_bridge,
             -- Rückblick: Lücken und Werft-Episoden, die vor dem Fenster beginnen
             $1::timestamptz - make_interval(hours => GREATEST($5, $7, $10)) AS t_look
    ),
    zones AS (
      SELECT * FROM unnest($13::text[], $14::float8[], $15::float8[], $16::float8[]) AS z(kind, lat, lon, radius_sm)
    ),
    evid AS (
      -- belegte Lay-ups/Werftaufenthalte: Pause mit Quelle bis zur Wiederaufnahme
      SELECT e.mmsi, (e.since::timestamp AT TIME ZONE 'UTC') AS t_from, r.resumed_at AS t_to
        FROM unnest($18::text[], $19::text[], $20::date[]) AS e(mmsi, imo, since)
        LEFT JOIN tracking_resume r ON r.dataset = $3 AND r.imo = e.imo AND r.paused_since = e.since
    ),
    sel AS (
      SELECT p.* FROM positions p, bounds b
       WHERE p.dataset = $3
         AND p.timestamp > b.t_look AND p.timestamp <= b.t1 + b.silent_min
         AND ${usable('p')}
      UNION ALL
      -- je Yacht die letzte Meldung davor (eine lange, beobachtete Liegezeit kann ins Fenster reichen)
      SELECT q.* FROM unnest($17::text[]) AS f(mmsi) CROSS JOIN bounds b
       CROSS JOIN LATERAL (
         SELECT p.* FROM positions p
          WHERE p.dataset = $3 AND p.mmsi = f.mmsi AND p.timestamp <= b.t_look
            AND ${usable('p')}
          ORDER BY p.timestamp DESC, p.id DESC LIMIT 1) q
    ),
    pts AS (
      SELECT s.*,
             LEAD(s.timestamp)   OVER w AS next_ts,
             LEAD(s.latitude)    OVER w AS next_lat,
             LEAD(s.longitude)   OVER w AS next_lon,
             LEAD(s.source)      OVER w AS next_source,
             LAG(s.latitude)     OVER w AS prev_lat,
             LAG(s.longitude)    OVER w AS prev_lon,
             LAG(s.speed_knots)  OVER w AS prev_sog
        FROM sel s
      WINDOW w AS (PARTITION BY s.mmsi ORDER BY s.timestamp, s.id)
    ),
    geo AS (
      SELECT pts.*,
             CASE WHEN pts.source = 'history' THEN b.max_gap_hist ELSE b.max_gap END AS gap_normal,
             (COALESCE(pts.speed_knots, 0) <= b.stat_v AND pts.latitude IS NOT NULL) AS slow,
             (pts.next_ts IS NOT NULL AND pts.latitude IS NOT NULL AND pts.next_lat IS NOT NULL
              AND ${hav('pts.latitude', 'pts.longitude', 'pts.next_lat', 'pts.next_lon')} <= b.stat_d) AS next_same,
             (pts.prev_lat IS NOT NULL AND pts.latitude IS NOT NULL AND COALESCE(pts.prev_sog, 0) <= b.stat_v
              AND ${hav('pts.prev_lat', 'pts.prev_lon', 'pts.latitude', 'pts.longitude')} <= b.stat_d) AS cont,
             CASE WHEN COALESCE(pts.speed_knots, 0) <= b.stat_v AND pts.latitude IS NOT NULL THEN (
               SELECT z.kind FROM zones z
                WHERE ABS(z.lat - pts.latitude) <= z.radius_sm / 60.0
                  AND ${hav('pts.latitude', 'pts.longitude', 'z.lat', 'z.lon')} <= z.radius_sm
                ORDER BY (z.kind = 'yard') DESC LIMIT 1) END AS zone,
             -- Abschnitt überschneidet einen belegten Zeitraum
             EXISTS (SELECT 1 FROM evid e WHERE e.mmsi = pts.mmsi
                        AND e.t_from < COALESCE(pts.next_ts, b.now_ts)
                        AND (e.t_to IS NULL OR pts.timestamp < e.t_to)) AS evid
        FROM pts, bounds b
    ),
    obs AS (
      SELECT geo.*,
             -- Lücke beobachtet? (jeder volle Tag dazwischen: Historie gekauft oder Live-Betrieb)
             CASE WHEN NOT next_same THEN false
                  WHEN (next_ts AT TIME ZONE 'UTC')::date - (geo.timestamp AT TIME ZONE 'UTC')::date <= 1 THEN true
                  ELSE NOT EXISTS (
                    SELECT 1 FROM generate_series((geo.timestamp AT TIME ZONE 'UTC')::date + 1,
                                                  (next_ts AT TIME ZONE 'UTC')::date - 1, interval '1 day') d(day)
                     WHERE d.day::date < b.live_since_day
                       AND NOT EXISTS (SELECT 1 FROM vessel_days v
                                        WHERE v.dataset = geo.dataset AND v.mmsi = geo.mmsi AND v.day = d.day::date
                                          AND v.history_status IN ('empty', 'done')))
             END AS gap_observed,
             -- Anker im Live-Betrieb (P-05): jeder volle Tag ab LIVE_SINCE dazwischen braucht eine frische
             -- Live-Meldung oder einen Historientag mit Daten; sonst war das AIS stumm (Datenlücke)
             CASE WHEN NOT next_same THEN false
                  WHEN (next_ts AT TIME ZONE 'UTC')::date - (geo.timestamp AT TIME ZONE 'UTC')::date <= 1 THEN true
                  ELSE NOT EXISTS (
                    SELECT 1 FROM generate_series((geo.timestamp AT TIME ZONE 'UTC')::date + 1,
                                                  (next_ts AT TIME ZONE 'UTC')::date - 1, interval '1 day') d(day)
                     WHERE d.day::date >= b.live_since_day
                       AND NOT EXISTS (SELECT 1 FROM vessel_days v
                                        WHERE v.dataset = geo.dataset AND v.mmsi = geo.mmsi AND v.day = d.day::date
                                          AND (v.live_hits > 0 OR v.history_status = 'done')))
             END AS live_seen,
             SUM(CASE WHEN cont THEN 0 ELSE 1 END) OVER (PARTITION BY geo.mmsi ORDER BY geo.timestamp, geo.id) AS ep_no,
             CASE WHEN slow AND next_same THEN next_ts
                  WHEN slow AND next_ts IS NULL THEN b.now_ts
                  ELSE geo.timestamp END AS stay_end
        FROM geo, bounds b
    ),
    st AS (
      SELECT obs.*,
             CASE
               WHEN NOT slow THEN 'underway'
               WHEN evid THEN 'layup_doc'
               WHEN zone = 'yard'
                    AND MAX(stay_end) OVER e - MIN(obs.timestamp) OVER e >= b.yard_min THEN 'yard'
               WHEN zone = 'port' AND obs.timestamp >= b.live_since
                    AND COALESCE(next_ts, b.now_ts) - obs.timestamp >= b.silent_min THEN 'layup'
               WHEN zone = 'port' THEN 'port'
               ELSE 'anchor'
             END AS state
        FROM obs, bounds b
      WINDOW e AS (PARTITION BY obs.mmsi, obs.ep_no)
    ),
    ends AS (
      SELECT st.*,
             CASE
               WHEN state = 'layup_doc' AND next_same THEN next_ts
               WHEN state = 'layup_doc' AND next_ts IS NULL THEN b.now_ts
               WHEN state IN ('yard', 'layup', 'port') AND next_same AND gap_observed THEN next_ts
               WHEN state IN ('yard', 'layup', 'port') AND next_ts IS NULL AND st.timestamp >= b.live_since THEN b.now_ts
               WHEN state = 'anchor' AND next_same AND gap_observed AND live_seen
                    AND (st.source = 'history' OR next_source = 'history') THEN next_ts
               WHEN slow AND next_same THEN LEAST(next_ts, st.timestamp + GREATEST(gap_normal, b.max_gap_stat))
               ELSE LEAST(COALESCE(next_ts, b.t1), st.timestamp + gap_normal)
             END AS end_raw
        FROM st, bounds b
    ),
    seg AS (
      SELECT ends.*,
             CASE WHEN state IN ('yard', 'layup', 'layup_doc') THEN 0 ELSE 1 END AS f,
             GREATEST(EXTRACT(EPOCH FROM (
               LEAST(CASE WHEN b.max_bridge > INTERVAL '0' THEN
                            LEAST(end_raw, ends.timestamp + GREATEST(b.max_bridge, gap_normal)) ELSE end_raw END,
                     b.t1)
               - GREATEST(ends.timestamp, b.t0))) / 3600.0, 0) AS dt_h,
             GREATEST(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(next_ts, b.t1), ends.timestamp + gap_normal, b.t1)
               - GREATEST(ends.timestamp, b.t0))) / 3600.0, 0) AS dt_normal_h
        FROM ends, bounds b
    )
    SELECT
      s.mmsi,
      (ARRAY_AGG(s.name     ORDER BY s.timestamp DESC) FILTER (WHERE s.timestamp <= b.t1))[1] AS name,
      (ARRAY_AGG(s.flag     ORDER BY s.timestamp DESC) FILTER (WHERE s.timestamp <= b.t1))[1] AS flag,
      (ARRAY_AGG(s.length_m ORDER BY s.timestamp DESC) FILTER (WHERE s.timestamp <= b.t1))[1] AS length_m,
      ROUND(SUM(s.co2_kg_h  * s.dt_h * s.f)::numeric, 1)::float8 AS co2_kg_total,
      ROUND(SUM(s.fuel_kg_h * s.dt_h * s.f)::numeric, 1)::float8 AS fuel_kg_total,
      ROUND(SUM(s.nox_kg_h  * s.dt_h * s.f)::numeric, 1)::float8 AS nox_kg_total,
      ROUND(SUM(s.sox_kg_h  * s.dt_h * s.f)::numeric, 2)::float8 AS sox_kg_total,
      ROUND(SUM(s.dt_h)::numeric, 2)::float8               AS coverage_h,
      $4::float8                                            AS period_h,
      COUNT(*) FILTER (WHERE s.timestamp > b.t0 AND s.timestamp <= b.t1)::int AS data_points,
      ROUND(SUM(s.dt_h) FILTER (WHERE s.source = 'history')::numeric, 2)::float8 AS coverage_history_h,
      ROUND(SUM(s.dt_h - s.dt_normal_h)::numeric, 2)::float8 AS coverage_bridged_h,
      ROUND(COALESCE(SUM(s.dt_h) FILTER (WHERE s.state = 'yard'), 0)::numeric, 2)::float8 AS coverage_yard_h,
      ROUND(COALESCE(SUM(s.dt_h) FILTER (WHERE s.state IN ('layup', 'layup_doc')), 0)::numeric, 2)::float8 AS coverage_layup_h,
      ROUND(COALESCE(SUM(s.dt_h) FILTER (WHERE s.state = 'layup'), 0)::numeric, 2)::float8 AS coverage_layup_unconfirmed_h,
      MAX(s.timestamp) FILTER (WHERE s.timestamp <= b.t1) AS last_seen
    FROM seg s CROSS JOIN bounds b
    GROUP BY s.mmsi
    HAVING SUM(s.dt_h) > 0
    ORDER BY co2_kg_total DESC NULLS LAST`;

const envNum = (env, k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));

// Parameter aus der Umgebung (Standardwerte = Entscheidungen Paul 2026-11-07/-15, Annahmen)
function stayParams(env = process.env) {
  const liveSince = env.LIVE_SINCE || '2026-11-12';   // Datalastic-Live-Abruf 2×/Tag seit 12.11.2026 (belegt: Railway-Log)
  if (Number.isNaN(Date.parse(liveSince))) throw new Error('LIVE_SINCE ungültig (YYYY-MM-DD)');
  return {
    maxGapHours: Number(env.MAX_GAP_HOURS) || 7,
    maxGapHoursHistory: Number(env.MAX_GAP_HOURS_HISTORY) || 1,
    stationaryMaxGapHours: envNum(env, 'STATIONARY_MAX_GAP_HOURS', 24),   // A32: ohne Beobachtung, Anker live
    stationaryVKn: envNum(env, 'STATIONARY_V_KN', 2),
    stationaryDistSm: envNum(env, 'STATIONARY_DIST_SM', 0.3),
    yardMinHours: envNum(env, 'STAY_YARD_MIN_HOURS', 72),                 // kurzer Halt an der Werft ≠ Refit
    silentMinDays: envNum(env, 'STAY_SILENT_MIN_DAYS', 30),               // Stille im Hafen → Lay-up
    maxBridgeDays: envNum(env, 'STAY_MAX_BRIDGE_DAYS', 0),                // 0 = unbegrenzt
    liveSince: new Date(liveSince),
  };
}

async function integrateEmissions(pool, win, { dataset, params = stayParams(), zones = [], evidence = [],
  fleetMmsi = [], now = new Date() } = {}) {
  const p = params;
  const r = await pool.query(SQL, [
    win.t0.toISOString(), win.t1.toISOString(), dataset, win.period_h,
    p.maxGapHours, p.maxGapHoursHistory, p.stationaryMaxGapHours, p.stationaryVKn, p.stationaryDistSm,
    p.yardMinHours, p.silentMinDays, p.liveSince.toISOString(),
    zones.map(z => z.kind), zones.map(z => z.lat), zones.map(z => z.lon), zones.map(z => z.radius_sm),
    fleetMmsi,
    evidence.map(e => e.mmsi), evidence.map(e => e.imo), evidence.map(e => e.since),
    p.maxBridgeDays, new Date(now).toISOString(),
  ]);
  return r.rows;
}

// Für /api/emissions/summary?meta=1 und den Methodenhinweis im Dashboard
function stayMeta(p, zones) {
  return {
    max_gap_hours: p.maxGapHours, max_gap_hours_history: p.maxGapHoursHistory,
    stationary_max_gap_hours: p.stationaryMaxGapHours, stationary_v_kn: p.stationaryVKn,
    stationary_dist_sm: p.stationaryDistSm,
    stay_yard_min_hours: p.yardMinHours, stay_silent_min_days: p.silentMinDays,
    stay_max_bridge_days: p.maxBridgeDays, live_since: p.liveSince.toISOString(),
    zones_ports: zones.filter(z => z.kind === 'port').length,
    zones_yards: zones.filter(z => z.kind === 'yard').length,
  };
}

module.exports = { integrateEmissions, stayParams, stayMeta, SQL };
