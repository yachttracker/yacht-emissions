require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');

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
// Ausgelagert nach fleet.js (gemeinsam mit der Abruflogik genutzt).
const { YACHTS } = require('./fleet');

// ── ABRUFLOGIK ───────────────────────────────────────────────────────────────
const cron = require('node-cron');
const { migrate } = require('./lib/schema');
const { loadConfig } = require('./lib/config');
const { getProvider } = require('./providers');
const planner = require('./lib/planner');
const credits = require('./lib/credits');
const { computeSchedule } = require('./lib/schedule');
const CFG = loadConfig();

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
  await migrate(pool);
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
      WHERE dataset = $1
      ORDER BY mmsi, timestamp DESC
    `, [CFG.dataset]);
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
      SELECT p.timestamp, p.latitude, p.longitude, p.speed_knots,
             p.co2_kg_h, p.fuel_kg_h, p.source
      FROM positions p
      WHERE p.mmsi = $1 AND p.dataset = $2
        AND p.timestamp > NOW() - INTERVAL '${interval}'
        -- Tage mit Historie: nur Historienpunkte, Live-Punkte ausblenden
        AND (p.source = 'history' OR NOT EXISTS (
              SELECT 1 FROM vessel_days v
               WHERE v.dataset = p.dataset AND v.mmsi = p.mmsi
                 AND v.day = (p.timestamp AT TIME ZONE 'UTC')::date
                 AND v.history_status = 'done'))
      ORDER BY p.timestamp ASC
    `, [mmsi, CFG.dataset]);
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
// Historie im 5-min-Raster: längere Lücke = echte Lücke (AIS aus / keine Abdeckung).
// Annahme: 1 h (Recherche 17.10.2026, Abschn. 6).
const MAX_GAP_HOURS_HISTORY = Number(process.env.MAX_GAP_HOURS_HISTORY) || 1;

// Menge = Σ Rate_i × Dauer_i, Dauer_i = [max(t_i, Fensterbeginn), min(t_(i+1), t_i + MAX_GAP(source), jetzt)]
// Je (Yacht, UTC-Tag) gilt: liegt Historie vor (vessel_days.history_status = 'done'),
// zählen nur Historienpunkte; sonst die Live-Punkte.
async function integrateEmissions(periodHours) {
  const result = await pool.query(`
    WITH bounds AS (
      SELECT NOW() - make_interval(hours => $1) AS t0,
             NOW()                              AS t1,
             make_interval(hours => $2)          AS max_gap,
             make_interval(hours => $3)          AS max_gap_hist
    ),
    pts AS (
      -- Meldungen kurz vor dem Fenster einbeziehen: ihre Rate gilt ggf. noch im Fenster
      SELECT p.*,
             LEAD(p.timestamp) OVER (PARTITION BY p.mmsi ORDER BY p.timestamp, p.id) AS next_ts
      FROM positions p, bounds b
      WHERE p.timestamp > b.t0 - b.max_gap
        AND p.timestamp <= b.t1
        AND p.dataset = $4
        AND p.source IN ('live', 'history')
        AND (p.source = 'history' OR NOT EXISTS (
              SELECT 1 FROM vessel_days v
               WHERE v.dataset = p.dataset AND v.mmsi = p.mmsi
                 AND v.day = (p.timestamp AT TIME ZONE 'UTC')::date
                 AND v.history_status = 'done'))
    ),
    seg AS (
      SELECT pts.*,
             GREATEST(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(next_ts, b.t1),
                     pts.timestamp + CASE WHEN pts.source = 'history' THEN b.max_gap_hist ELSE b.max_gap END,
                     b.t1)
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
      ROUND(SUM(s.dt_h) FILTER (WHERE s.source = 'history')::numeric, 2)::float8 AS coverage_history_h,
      MAX(s.timestamp) AS last_seen
    FROM seg s
    GROUP BY s.mmsi
    HAVING SUM(s.dt_h) > 0
    ORDER BY co2_kg_total DESC
  `, [periodHours, MAX_GAP_HOURS, MAX_GAP_HOURS_HISTORY, CFG.dataset]);
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

// ── ABRUF-STATUS (öffentlich, nur lesend) ────────────────────────────────────
app.get('/api/status', async (_, res) => {
  try {
    let provider = null;
    try { provider = getProvider(); } catch (e) { /* Konfigurationsfehler unten melden */ }
    const st = provider ? await credits.status(pool, CFG, provider.name) : null;
    const days = await pool.query(`
      SELECT COUNT(*)::int AS yacht_days,
             COUNT(*) FILTER (WHERE history_status = 'done')::int  AS history_done,
             COUNT(*) FILTER (WHERE moved)::int                    AS detected_moved,
             -- Kontrolle der Erkennung an Tagen mit Historie
             COUNT(*) FILTER (WHERE history_moved AND moved)::int      AS hist_moved_detected,
             COUNT(*) FILTER (WHERE history_moved AND NOT moved)::int  AS hist_moved_missed,
             MAX(updated_at) AS last_update
        FROM vessel_days WHERE dataset = $1 AND day > (NOW() AT TIME ZONE 'UTC')::date - 30`, [CFG.dataset]);
    res.json({ provider: CFG.provider, dataset: CFG.dataset, dry_run: CFG.dryRun,
               schedule: provider ? computeSchedule(CFG, YACHTS.length, provider.COSTS) : null,
               history_hour_utc: CFG.historyHourUtc, history_timegroup_min: CFG.timegroupMin,
               credits: st, last_30_days: days.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN (nur mit ADMIN_TOKEN; ohne Variable deaktiviert) ───────────────────
function admin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(403).json({ error: 'forbidden' });
  next();
}
// Plan ansehen, ohne Credits auszugeben: /admin/plan?lookback=14&backfill=true
app.get('/admin/plan', admin, async (req, res) => {
  try {
    const provider = getProvider();
    if (!provider) return res.status(400).json({ error: 'AIS_PROVIDER=none' });
    const plan = await planner.planHistory(pool, provider, CFG, {
      lookbackDays: Number(req.query.lookback) || CFG.lookbackDays, backfill: req.query.backfill === 'true' });
    res.json({ ...plan, skipped: plan.skipped.length, selected: plan.selected.map(c => `${c.day} ${c.name} P${c.prio} (${c.why})`) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/admin/poll', admin, async (_, res) => {
  try { res.json(await runJob('poll')); } catch (err) { res.status(500).json({ error: err.message }); }
});
// Historie jetzt abrufen; ?lookback=14&backfill=true für den Startbestand
app.post('/admin/history', admin, async (req, res) => {
  try {
    res.json(await runJob('history', { lookbackDays: Number(req.query.lookback) || CFG.lookbackDays,
                                       backfill: req.query.backfill === 'true' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ZEITPLAN ─────────────────────────────────────────────────────────────────
let jobRunning = false;
async function runJob(kind, opts = {}) {
  const provider = getProvider();
  if (!provider) return { skipped: 'AIS_PROVIDER=none' };
  if (!CFG.dryRun && (!CFG.monthBudget || !CFG.dailyCap)) {
    throw new Error('CREDIT_MONTH_BUDGET und CREDIT_DAILY_CAP müssen gesetzt sein');
  }
  if (jobRunning) return { skipped: 'anderer Abruf läuft' };
  jobRunning = true;
  try {
    const r = kind === 'poll'
      ? await planner.pollLive(pool, provider, CFG, { extended: opts.extended })
      : await planner.runHistory(pool, provider, CFG, opts);
    console.log(`[ABRUF] ${kind}`, JSON.stringify(r).slice(0, 500));
    return r;
  } finally { jobRunning = false; }
}

function startScheduler() {
  if (CFG.provider === 'none') { console.log('[ABRUF] AIS_PROVIDER=none – kein Zeitplan'); return; }
  const provider = getProvider();   // wirft bei Fehlkonfiguration sofort
  const sch = computeSchedule(CFG, YACHTS.length, provider.COSTS);
  if (sch.over_budget) console.warn(`[ABRUF] WARNUNG: geplant ${sch.projected_month_31d} Credits > Budget ${CFG.monthBudget}`);
  const hours = sch.hours_utc.join(',');
  cron.schedule(`7 ${hours} * * *`, () => {
    const extended = CFG.liveExtended && new Date().getUTCHours() === sch.extended_hour_utc;
    runJob('poll', { extended }).catch(e => console.error('[ABRUF] poll', e.message));
  }, { timezone: 'Etc/UTC' });
  cron.schedule(`23 ${CFG.historyHourUtc} * * *`, () => {
    runJob('history').catch(e => console.error('[ABRUF] history', e.message));
  }, { timezone: 'Etc/UTC' });
  console.log(`[ABRUF] ${CFG.provider} (${CFG.dataset}${CFG.dryRun ? ', dry-run' : ''}): ${YACHTS.length} Yachten, ` +
    `Live ${sch.polls_per_day}×/Tag (${hours} UTC, extended ${sch.extended_hour_utc}), Historie ${CFG.historyHourUtc}:23 UTC ` +
    `im ${CFG.timegroupMin}-min-Raster, Plan ${sch.projected_month_31d} Credits/31 Tage (${sch.share_pct} %)`);
}

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// DB beim Start bis zu 10× versuchen statt sofort abzustürzen (bekannter Mangel)
async function setupWithRetry(tries = 10) {
  for (let i = 1; ; i++) {
    try { return await setupDB(); }
    catch (e) {
      if (i >= tries) throw e;
      console.error(`[DB] nicht erreichbar (${e.message}), neuer Versuch ${i + 1}/${tries} in 10 s`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

setupWithRetry().then(() => {
 // connectAIS();
  startScheduler();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
  
