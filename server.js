require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');
const fetch = require('node-fetch');

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
  { mmsi: '319225400', name: 'Koru',       owner: 'Jeff Bezos',        length: 127, flag: '🇰🇾' },
  { mmsi: '319094900', name: 'Flying Fox', owner: 'Undisclosed',       length: 136, flag: '🇧🇸' },
  { mmsi: '319074900', name: 'Dilbar',     owner: 'Alisher Usmanov',   length: 156, flag: '🇨🇮' },
  { mmsi: '319085900', name: 'Solaris',    owner: 'Roman Abramovich',  length: 140, flag: '🇧🇸' },
  { mmsi: '308500800', name: 'Lady Moura', owner: 'Nasser Al-Rashid',  length: 105, flag: '🇧🇸' },
];

// ── EMISSION CALCULATION (IMO MEPC methodology) ──────────────────────────────
// MCR estimated from length (regression from Lloyd's Register data)
function estimateMCR(lengthM) {
  return Math.round(50 * Math.pow(lengthM, 1.2));
}

function calcHourlyEmissions(lengthM, speedKnots) {
  const mcr = estimateMCR(lengthM);
  const loadFactor = speedKnots > 1 ? 0.75 : 0.15; // underway vs hotel load
  const sfcMain = 185;   // g/kWh
  const sfcAux  = 210;   // g/kWh
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
      nav_status INTEGER,
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

// ── FETCH & STORE POSITIONS ──────────────────────────────────────────────────
async function fetchAndStore() {
  console.log('Fetching positions...');
  for (const yacht of YACHTS) {
    try {
      const res = await fetch(
        `https://api.vesselapi.com/v1/vessel/${yacht.mmsi}/position?filter.idType=mmsi`,
        { headers: { Authorization: `Bearer ${process.env.VESSEL_API_KEY}` } }
      );
      const data = await res.json();
      const p = data.vesselPosition;
      if (!p) continue;

      const em = calcHourlyEmissions(yacht.length, p.sog || 0);

      await pool.query(`
        INSERT INTO positions
          (mmsi, name, owner, flag, length_m, latitude, longitude,
           speed_knots, heading, nav_status,
           co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        yacht.mmsi, yacht.name, yacht.owner, yacht.flag, yacht.length,
        p.latitude, p.longitude, p.sog, p.heading, p.nav_status,
        em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h,
        p.timestamp
      ]);
      console.log(`Stored: ${yacht.name}`);
    } catch (err) {
      console.error(`Error fetching ${yacht.name}:`, err.message);
    }
  }
}

// ── API ENDPOINTS ────────────────────────────────────────────────────────────

// Latest position + emissions for all yachts
app.get('/api/yachts/latest', async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT ON (mmsi) *
    FROM positions
    ORDER BY mmsi, timestamp DESC
  `);
  res.json(result.rows);
});

// Historical data for a yacht (day/week/month)
app.get('/api/yacht/:mmsi/history', async (req, res) => {
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
});

// Cumulative emissions per yacht for a period
app.get('/api/emissions/summary', async (req, res) => {
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
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

setupDB().then(() => {
  // Fetch immediately on start, then every 10 minutes
  fetchAndStore();
  cron.schedule('*/10 * * * *', fetchAndStore);

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
