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
  { mmsi: '319225400', name: 'Koru',      owner: 'Jeff Bezos',         length: 127, flag: '🇰🇾' },
  { mmsi: '319032600', name: 'Musashi',   owner: 'Larry Ellison',      length: 88,  flag: '🇰🇾' },
  { mmsi: '227003660', name: 'Symphony',  owner: 'Bernard Arnault',    length: 101, flag: '🇫🇷' },
  { mmsi: '319040900', name: 'Aquila',    owner: 'Bill Gates',         length: 88,  flag: '🇰🇾' },
  { mmsi: '319111900', name: 'Amadea',    owner: 'Suleiman Kerimov',   length: 106, flag: '🇰🇾' },
  { mmsi: '319104900', name: 'Tis',       owner: 'Undisclosed',        length: 110, flag: '🇨🇮' },
  { mmsi: '319069900', name: 'Kismet',    owner: 'Shahid Khan',        length: 95,  flag: '🇰🇾' },
  { mmsi: '319201400', name: 'Moonrise',  owner: 'Undisclosed',        length: 90,  flag: '🇰🇾' },
  { mmsi: '319093400', name: 'My Seanna', owner: 'Undisclosed',        length: 73,  flag: '🇰🇾' },
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

// ── FETCH & STORE POSITIONS ──────────────────────────────────────────────────
async function fetchAndStore() {
  console.log('Fetching positions...');
  for (const yacht of YACHTS) {
    try {
      const res = await fetch(
        `https://api.vesselapi.com/v1/vessel/${yacht.mmsi}/position`,
        { headers: { Authorization: `Bearer ${process.env.VESSEL_API_KEY}` } }
      );

      if (!res.ok) {
        console.error(`HTTP ${res.status} for ${yacht.name}`);
        continue;
      }

      const p = await res.json();

      // VesselAPI returns position fields directly (no nested object)
      if (!p || !p.latitude || !p.longitude) {
        console.warn(`No position data for ${yacht.name}`);
        continue;
      }

      const em = calcHourlyEmissions(yacht.length, p.sog || 0);

      await pool.query(`
        INSERT INTO positions
          (mmsi, name, owner, flag, length_m, latitude, longitude,
           speed_knots, heading, nav_status,
           co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        yacht.mmsi, yacht.name, yacht.owner, yacht.flag, yacht.length,
        p.latitude, p.longitude,
        p.sog || 0,
        p.heading || null,
        p.navStatus || null,       // camelCase per VesselAPI docs
        em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h,
        p.timestamp || new Date().toISOString()
      ]);
      console.log(`Stored: ${yacht.name} @ ${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)} — ${p.sog || 0} kn`);

    } catch (err) {
      console.error(`Error fetching ${yacht.name}:`, err.message);
    }
  }
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

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

setupDB().then(() => {
  fetchAndStore();
  cron.schedule('*/10 * * * *', fetchAndStore);
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

  
