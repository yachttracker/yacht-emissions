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
  ssl: { rejectUnauthorized: false }
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

// ── EMISSION CALCULATION (IMO MEPC methodology) ──────────────────────────────
function estimateMCR(lengthM) {
  return Math.round(50 * Math.pow(lengthM, 1.2));
}

function calcHourlyEmissions(lengthM, speedKnots) {
  const mcr = estimateMCR(lengthM);
  const loadFactor = speedKnots > 1 ? 0.75 : 0.15;
  const sfcMain = 185;
  const sfcAux  = 210;
  const auxKw   = mcr * 0.15;

  const mainFuelKgH = (mcr * loadFactor * sfcMain) / 1e6 * 1000;
  const auxFuelKgH  = (auxKw * 0.6 * sfcAux) / 1e6 * 1000;
  const totalFuelKgH = mainFuelKgH + auxFuelKgH;

  return {
    co2_kg_h:  totalFuelKgH * 3.114,
    nox_kg_h:  totalFuelKgH * 0.087,
    sox_kg_h:  totalFuelKgH * 0.022,
    fuel_kg_h: totalFuelKgH,
  };
}

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

        const em = calcHourlyEmissions(yacht.length, sog);

        await pool.query(`
          INSERT INTO positions
            (mmsi, name, owner, flag, length_m, latitude, longitude,
             speed_knots, heading, nav_status,
             co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          yacht.mmsi, yacht.name, yacht.owner, yacht.flag, yacht.length,
          lat, lon, sog,
          heading || null,
          navStatus !== undefined ? String(navStatus) : null,
          em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h,
          meta.time_utc || new Date().toISOString()
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

// Cumulative emissions per yacht for a period
app.get('/api/emissions/summary', async (req, res) => {
  try {
    const { period = 'day' } = req.query;
    const intervals = { day: '1 day', week: '7 days', month: '30 days' };
    const interval = intervals[period] || '1 day';

    const result = await pool.query(`
      SELECT
        mmsi, name, owner, flag, length_m,
        ROUND(SUM(co2_kg_h)::numeric, 1)  AS co2_kg_total,
        ROUND(SUM(fuel_kg_h)::numeric, 1) AS fuel_kg_total,
        ROUND(SUM(nox_kg_h)::numeric, 1)  AS nox_kg_total,
        COUNT(*) AS data_points,
        MAX(timestamp) AS last_seen
      FROM positions
      WHERE timestamp > NOW() - INTERVAL '${interval}'
      GROUP BY mmsi, name, owner, flag, length_m
      ORDER BY co2_kg_total DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));
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
  
