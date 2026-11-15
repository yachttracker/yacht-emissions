// ── Liegeorte aus den eigenen AIS-Daten (/api/stays, nur mit Zugang) ────────────────────
// Zweck (Paul 2026-11-15): data/ports.csv und data/yards.csv nur für Orte füllen, an denen unsere
// Yachten tatsächlich liegen. Koordinaten kommen aus den Meldungen; recherchiert wird nur noch,
// was dort ist (Hafen oder Werft) – mit Quelle.
//
// Episode = aufeinanderfolgende Halte am selben Ort (wie lib/integrate.js). Aufgeführt werden
// Episoden ≥ min_hours (Standard 72 h) und offene Episoden (letzte Meldung der Yacht ist ein Halt;
// Dauer bis jetzt, z. B. Yacht schweigt im Hafen). Episoden in ≤ CLUSTER_SM Abstand werden zu
// einem Ort zusammengefasst.

const CLUSTER_SM = 1.0;   // Annahme: Hafenbecken/Werftgelände liegen innerhalb ~1 sm

function distSm(a, b) {
  const R = 3440.065, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const SQL = `
  WITH p AS (
    SELECT p.mmsi, p.name, p.timestamp, p.latitude AS lat, p.longitude AS lon,
           COALESCE(p.speed_knots, 0) AS sog,
           LAG(p.latitude)    OVER w AS plat,
           LAG(p.longitude)   OVER w AS plon,
           LAG(p.speed_knots) OVER w AS psog,
           LEAD(p.timestamp)  OVER w AS nts
      FROM positions p
     WHERE p.dataset = $1 AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL
       AND p.source IN ('live', 'history')
       AND (p.source = 'history' OR NOT EXISTS (
             SELECT 1 FROM vessel_days v
              WHERE v.dataset = p.dataset AND v.mmsi = p.mmsi
                AND v.day = (p.timestamp AT TIME ZONE 'UTC')::date AND v.history_status = 'done'))
    WINDOW w AS (PARTITION BY p.mmsi ORDER BY p.timestamp, p.id)
  ),
  q AS (
    SELECT p.*,
           (plat IS NOT NULL AND COALESCE(psog, 0) <= $2
            AND 2 * 3440.065 * ASIN(LEAST(1, SQRT(POWER(SIN(RADIANS(lat - plat) / 2), 2)
                + COS(RADIANS(plat)) * COS(RADIANS(lat)) * POWER(SIN(RADIANS(lon - plon) / 2), 2)))) <= $3) AS cont
      FROM p
  ),
  r AS (
    SELECT q.*, SUM(CASE WHEN cont THEN 0 ELSE 1 END) OVER (PARTITION BY mmsi ORDER BY timestamp) AS ep
      FROM q
  )
  SELECT mmsi,
         (ARRAY_AGG(name ORDER BY timestamp DESC))[1]           AS name,
         MIN(timestamp)                                         AS t_from,
         MAX(timestamp)                                         AS t_to,
         AVG(lat) FILTER (WHERE sog <= $2)                      AS lat,
         AVG(lon) FILTER (WHERE sog <= $2)                      AS lon,
         COUNT(*)::int                                          AS points,
         BOOL_OR(nts IS NULL AND sog <= $2)                     AS open
    FROM r
   GROUP BY mmsi, ep
  HAVING COUNT(*) FILTER (WHERE sog <= $2) > 0`;

async function listStays(pool, { dataset, zones = [], minHours = 72, vKn = 2, distSm: d = 0.3, now = new Date() } = {}) {
  const rows = (await pool.query(SQL, [dataset, vKn, d])).rows;
  const nowMs = new Date(now).getTime();
  const eps = rows.map(r => {
    const from = new Date(r.t_from).getTime();
    const end = r.open ? nowMs : new Date(r.t_to).getTime();
    return { mmsi: r.mmsi, name: r.name, lat: Number(r.lat), lon: Number(r.lon), points: r.points, open: !!r.open,
      t_from: new Date(from).toISOString(), t_to: new Date(new Date(r.t_to).getTime()).toISOString(),
      hours: (end - from) / 3600000 };
  }).filter(e => Number.isFinite(e.lat) && e.hours >= minHours)
    .sort((a, b) => b.hours - a.hours);

  const clusters = [];
  for (const e of eps) {
    let c = clusters.find(x => distSm(x, e) <= CLUSTER_SM);
    if (!c) { c = { lat: e.lat, lon: e.lon, eps: [] }; clusters.push(c); }
    c.eps.push(e);
    // Mittelpunkt gewichtet nach Liegedauer
    const w = c.eps.reduce((s, x) => s + x.hours, 0);
    c.lat = c.eps.reduce((s, x) => s + x.lat * x.hours, 0) / w;
    c.lon = c.eps.reduce((s, x) => s + x.lon * x.hours, 0) / w;
  }

  return clusters.map(c => {
    const spread = Math.max(0, ...c.eps.map(e => distSm(c, e)));
    const zone = zones.find(z => distSm(z, c) <= z.radius_sm) || null;
    const yachts = [...new Map(c.eps.map(e => [e.mmsi, e.name])).entries()].map(([mmsi, name]) => ({ mmsi, name }));
    const hours = c.eps.reduce((s, e) => s + e.hours, 0);
    return {
      lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4),
      radius_sm_suggested: Math.max(0.3, Math.ceil((spread + 0.3) * 10) / 10),   // Annahme: Streuung + 0,3 sm
      zone: zone ? { kind: zone.kind, name: zone.name } : null,
      yachts, episodes: c.eps.length,
      hours_total: Math.round(hours), hours_max: Math.round(Math.max(...c.eps.map(e => e.hours))),
      open_now: c.eps.filter(e => e.open).map(e => ({ name: e.name, since: e.t_to })),
      first: c.eps.map(e => e.t_from).sort()[0], last: c.eps.map(e => e.t_to).sort().pop(),
      csv: `;${c.lat.toFixed(4)};${c.lon.toFixed(4)};${Math.max(0.3, Math.ceil((spread + 0.3) * 10) / 10)};;`,
    };
  }).sort((a, b) => b.hours_total - a.hours_total);
}

module.exports = { listStays, distSm, CLUSTER_SM };
