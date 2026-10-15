require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');
const { runCoverageTest, getCoverageResult } = require('./debug-coverage');

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // DATABASE_SSL=false nur für lokale Tests ohne SSL; Railway nutzt den Standard
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

// ── YACHT LIST (MMSI + static data) ─────────────────────────────────────────
const YACHTS = [
  { mmsi: '319225400', name: 'Koru',         owner: 'Jeff Bezos',                 length: 127, flag: '🇰🇾' },
  { mmsi: '538071886', name: 'Carinthia VII', owner: 'Porsche/Piëch-Familie',     length: 75,  flag: '🇲🇭' },
  { mmsi: '319318200', name: 'My Deep Blue', owner: 'unbestätigt',                 length: 134, flag: '🇰🇾' },
  { mmsi: '538072122', name: 'Launchpad',    owner: 'Mark Zuckerberg',            length: 118, flag: '🇲🇭' },
  { mmsi: '319205400', name: 'Boardwalk',    owner: 'Tilman Fertitta',            length: 77,  flag: '🇰🇾' },
  { mmsi: '538071476', name: 'Kismet',       owner: 'Shahid Khan',                length: 122, flag: '🇲🇭' },
  { mmsi: '319076700', name: 'Symphony',     owner: 'Bernard Arnault',            length: 101, flag: '🇰🇾' },
  { mmsi: '319306800', name: 'Moonrise',     owner: 'Undisclosed',                length: 100, flag: '🇰🇾' },
  { mmsi: '311001556', name: 'Emerald Kaia', owner: 'Emerald Cruises (kommerziell)', length: 142, flag: '🇧🇸' },
  { mmsi: '319032600', name: 'Musashi',      owner: 'Larry Ellison',              length: 88,  flag: '🇰🇾' },
];

// ── EMISSION CALCULATION ─────────────────────────────────────────────────────
// Parameter, Quellen und Status: siehe emissions.js und 02_methodik.md.
// Optionale Felder je Yacht: mcr_kw (installierte Antriebsleistung), vmax_kn.
// Solange sie fehlen, greifen gekennzeichnete Fallbacks (mcr_estimated = true).
const { calcHourlyEmissions, CALC_VERSION } = require('./emissions');

// ── DATABASE SETUP ───────────────────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      mmsi TEXT NOT NULL,
      name TEXT,
      owner TEXT,
      flag TEXT,
      length_m INTEGER,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      speed_knots DOUBLE PRECISION,
      heading INTEGER,
      nav_status TEXT,
      co2_kg_h DOUBLE PRECISION,
      nox_kg_h DOUBLE PRECISION,
      sox_kg_h DOUBLE PRECISION,
      fuel_kg_h DOUBLE PRECISION,
      timestamp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_positions_mmsi ON positions(mmsi);
    CREATE INDEX IF NOT EXISTS idx_positions_timestamp ON positions(timestamp);
    -- Nachvollziehbarkeit der gespeicherten Raten (seit 2026-10-15-v2)
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS me_load DOUBLE PRECISION;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS mcr_kw DOUBLE PRECISION;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS mcr_estimated BOOLEAN;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS calc_version TEXT;
  `);
  console.log('Database ready');
}

// ── PERMANENTE AIS-VERBINDUNG (aisstream.io) ─────────────────────────────────
function connectAIS() {
  const apiKey = process.env.AISSTREAM_API_KEY;

  if (!apiKey) {
    console.error('[AIS] AISSTREAM_API_KEY nicht gesetzt — Verbindung wird nicht aufgebaut');
    return;
  }

  console.log('[AIS] Verbindung zu aisstream.io wird aufgebaut...');
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  const mmsiList = YACHTS.map(y => y.mmsi);

  ws.on('open', () => {
    console.log('[AIS] Verbunden. Abonniere', mmsiList.length, 'Yachten...');
    const subscriptionMessage = {
      APIKey: apiKey,
      BoundingBoxes: [[[-180, -90], [180, 90]]],
      FiltersShipMMSI: mmsiList
    };
    ws.send(JSON.stringify(subscriptionMessage));
  });

  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.MessageType === 'PositionReport') {
        const report = parsed.Message.PositionReport;
        const meta = parsed.MetaData;
        const mmsi = String(meta.MMSI || report.UserID);

        const yacht = YACHTS.find(y => y.mmsi === mmsi);
        if (!yacht) return;

        const lat = report.Latitude;
        const lon = report.Longitude;
        const sog = report.Sog || 0;
        const heading = report.TrueHeading;
        const navStatus = report.NavigationalStatus;

        const em = calcHourlyEmissions(yacht, sog, navStatus);

        await pool.query(`
          INSERT INTO positions
            (mmsi, name, owner, flag, length_m, latitude, longitude,
             speed_knots, heading, nav_status,
             co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp,
             me_load, mcr_kw, mcr_estimated, calc_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        `, [
          yacht.mmsi, yacht.name, yacht.owner, yacht.flag, yacht.length,
          lat, lon, sog,
          heading || null,
          navStatus !== undefined ? String(navStatus) : null,
          em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h,
          meta.time_utc || new Date().toISOString(),
          em.me_load, em.mcr_kw, em.mcr_estimated, em.calc_version
        ]);

        console.log(`[AIS] ${yacht.name}: ${lat.toFixed(3)}, ${lon.toFixed(3)} @ ${sog} kn`);
      }
    } catch (err) {
      console.error('[AIS] Fehler beim Verarbeiten einer Nachricht:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[AIS] WebSocket-Fehler:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.warn(`[AIS] Verbindung geschlossen (Code ${code}, Grund: ${reason}). Reconnect in 5 Sekunden...`);
    setTimeout(connectAIS, 5000);
  });
}

// ── API ENDPOINTS ────────────────────────────────────────────────────────────

// Latest position + emissions for all yachts
app.get('/api/yachts/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (mmsi) *
      FROM positions
      ORDER BY mmsi, timestamp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historical data for a yacht (day/week/month)
app.get('/api/yacht/:mmsi/history', async (req, res) => {
  try {
    const { mmsi } = req.params;
    const { period = 'day' } = req.query;
    const intervals = { day: '1 day', week: '7 days', month: '30 days' };
    const interval = intervals[period] || '1 day';

    const result = await pool.query(`
      SELECT timestamp, latitude, longitude, speed_knots,
             co2_kg_h, fuel_kg_h
      FROM positions
      WHERE mmsi = $1
        AND timestamp > NOW() - INTERVAL '${interval}'
      ORDER BY timestamp ASC
    `, [mmsi]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ZEITINTEGRATION ──────────────────────────────────────────────────────────
// Jede Meldung liefert eine Rate (kg/h). Diese Rate gilt ab ihrem Zeitstempel
// bis zur nächsten Meldung derselben Yacht, höchstens aber MAX_GAP_HOURS lang.
// Längere Lücken zählen nicht als Emission, sondern werden als "nicht abgedeckt"
// ausgewiesen (coverage_h). Annahme: größtes geplantes Polling-Intervall 6 h
// (unbewegte Yachten) + 1 h Toleranz für verspätete Meldungen.
const MAX_GAP_HOURS = Number(process.env.MAX_GAP_HOURS) || 7;

// Menge = Σ Rate_i × Dauer_i, Dauer_i = [max(t_i, Fensterbeginn), min(t_(i+1), t_i + MAX_GAP, jetzt)]
async function integrateEmissions(periodHours) {
  const result = await pool.query(`
    WITH bounds AS (
      SELECT NOW() - make_interval(hours => $1) AS t0,
             NOW()                              AS t1,
             make_interval(hours => $2)          AS max_gap
    ),
    pts AS (
      -- Meldungen kurz vor dem Fenster einbeziehen: ihre Rate gilt ggf. noch im Fenster
      SELECT p.*,
             LEAD(p.timestamp) OVER (PARTITION BY p.mmsi ORDER BY p.timestamp, p.id) AS next_ts
      FROM positions p, bounds b
      WHERE p.timestamp > b.t0 - b.max_gap
        AND p.timestamp <= b.t1
    ),
    seg AS (
      SELECT pts.*,
             GREATEST(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(next_ts, b.t1), pts.timestamp + b.max_gap, b.t1)
               - GREATEST(pts.timestamp, b.t0)
             )) / 3600.0, 0) AS dt_h
      FROM pts, bounds b
    )
    SELECT
      s.mmsi,
      (ARRAY_AGG(s.name     ORDER BY s.timestamp DESC))[1] AS name,
      (ARRAY_AGG(s.owner    ORDER BY s.timestamp DESC))[1] AS owner,
      (ARRAY_AGG(s.flag     ORDER BY s.timestamp DESC))[1] AS flag,
      (ARRAY_AGG(s.length_m ORDER BY s.timestamp DESC))[1] AS length_m,
      ROUND(SUM(s.co2_kg_h  * s.dt_h)::numeric, 1)::float8 AS co2_kg_total,
      ROUND(SUM(s.fuel_kg_h * s.dt_h)::numeric, 1)::float8 AS fuel_kg_total,
      ROUND(SUM(s.nox_kg_h  * s.dt_h)::numeric, 1)::float8 AS nox_kg_total,
      ROUND(SUM(s.sox_kg_h  * s.dt_h)::numeric, 2)::float8 AS sox_kg_total,
      ROUND(SUM(s.dt_h)::numeric, 2)::float8               AS coverage_h,
      $1::float8                                            AS period_h,
      COUNT(*) FILTER (WHERE s.timestamp > (SELECT t0 FROM bounds))::int AS data_points,
      MAX(s.timestamp) AS last_seen
    FROM seg s
    GROUP BY s.mmsi
    HAVING SUM(s.dt_h) > 0
    ORDER BY co2_kg_total DESC
  `, [periodHours, MAX_GAP_HOURS]);
  return result.rows;
}

// Cumulative emissions per yacht for a period (zeitgewichtet integriert)
app.get('/api/emissions/summary', async (req, res) => {
  try {
    const { period = 'day' } = req.query;
    const periodHours = { day: 24, week: 24 * 7, month: 24 * 30 }[period] || 24;
    res.json(await integrateEmissions(periodHours));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', calc_version: CALC_VERSION }));
app.get('/debug/coverage-test/start', (req, res) => {
  runCoverageTest();
  res.json({ message: 'Coverage-Test gestartet (Rotterdam, 20 Sekunden)' });
});

app.get('/debug/coverage-test/status', (req, res) => {
  res.json(getCoverageResult());
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

setupDB().then(() => {
 // connectAIS();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
  
