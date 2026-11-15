require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const WebSocket = require('ws');

const app = express();
// Railway leitet Anfragen über einen Proxy weiter → echte Client-IP aus X-Forwarded-For
// (Annahme: genau ein Proxy davor; nötig für das Rate-Limit je IP)
app.set('trust proxy', 1);
app.disable('x-powered-by');

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
const { computeSchedule, daysPerHistoryCall } = require('./lib/schedule');
const identity = require('./lib/identity');
const tracking = require('./lib/tracking');
const CFG = loadConfig();
// Identitätsabgleich über die IMO: alle N Tage (Standard 7), beim Start nachgeholt, wenn überfällig
const IDENTITY_CHECK_DAYS = Number(process.env.IDENTITY_CHECK_DAYS) || 7;

// ── EMISSION CALCULATION ─────────────────────────────────────────────────────
// Parameter, Quellen und Status: siehe emissions.js und 02_methodik.md.
// Optionale Felder je Yacht: mcr_kw (installierte Antriebsleistung), vmax_kn.
// Solange sie fehlen, greifen gekennzeichnete Fallbacks (mcr_estimated = true).
const { calcHourlyEmissions, CALC_VERSION } = require('./emissions');

// ── DASHBOARD: Zeitfenster, Eigentümer, Schutz ───────────────────────────────
const { resolveWindow, windowKey, WindowError } = require('./lib/periods');
const ownersLib = require('./lib/owners');
const { createAdminGuard, createLimiter, rateLimit, securityHeaders } = require('./lib/security');
const { createDashboard } = require('./lib/dashboard');
const { mountAdmin } = require('./lib/admin');
const ownerStore = ownersLib.createOwnerStore(pool);
const dash = createDashboard({ pool, CFG, YACHTS });
const requireAdmin = createAdminGuard();
// Öffentliche API: großzügiges Limit je IP (Schutz vor Dauerabfragen, Annahme 240/min)
const apiLimiter = rateLimit(createLimiter({ windowMs: 60000, max: Number(process.env.API_RATE_PER_MIN) || 240 }));

app.use(securityHeaders);
// Sichtbarkeit: SITE_ACCESS=public | private (Standard private), Details lib/access.js.
// Steht vor Frontend, API und Admin, damit im privaten Modus nichts ohne Zugang ausgeliefert wird.
const { createSiteGate, siteMode } = require('./lib/access');
app.use(createSiteGate());
app.use(cors());
app.use(express.json({ limit: '20kb' }));
// Statisches Frontend aus public/ (index.html, admin/, js/, css/, vendor/)
// HTML, JS und CSS: no-cache = Browser fragt bei jedem Laden per ETag nach (304, kaum Last),
// damit nach einem Deploy sofort die neue Version gilt. Schriften/Leaflet/Icons: 5 min Cache.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));
// Jede öffentliche API-Antwort läuft durch die zentrale Eigentümer-Maskierung
app.use('/api', apiLimiter, ownersLib.publicApi(ownerStore));

// ── DATABASE SETUP ───────────────────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      mmsi TEXT NOT NULL,
      name TEXT,
      owner TEXT,
      flag TEXT,
      length_m DOUBLE PRECISION,
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
  await ownersLib.migrateOwners(pool);
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

// Öffentliche Ansicht ohne AIS-Rohdaten (Datalastic Terms §8, seit 2026-11-12):
// Ohne Zugang gibt die API im öffentlichen Modus keine Positionen, Geschwindigkeiten, Navigationsstatus
// oder Anbieter-Datensätze aus; Verläufe nur als Stundenmittel der berechneten Raten
// (PUBLIC_MIN_BUCKET_S, Annahme: grob genug, dass sich kein Positions-/Fahrtverlauf rekonstruieren lässt).
// Mit Zugang (Cookie, ?access=, x-site-access, Basic) bleibt alles wie im privaten Modus.
const PUBLIC_MIN_BUCKET_S = Number(process.env.PUBLIC_MIN_BUCKET_S) || 3600;
const publicView = (req) => siteMode() === 'public' && !req.siteTrusted;
// true → Antwort gesendet (Rohdaten-Endpunkt ohne Zugang im öffentlichen Modus)
function deniedRaw(req, res) {
  if (!publicView(req)) return false;
  res.status(403).json({ error: 'not available in the public dashboard (raw AIS data, data provider licence)' });
  return true;
}

// Latest position + emissions for all yachts
// Spalten ausdrücklich ohne positions.owner (Eigentümer kommen nur aus vessel_owner, maskiert)
const LATEST_COLUMNS = `id, mmsi, name, flag, length_m, latitude, longitude, speed_knots, heading, cog, nav_status,
  co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp, created_at, me_load, mcr_kw, mcr_estimated,
  calc_version, source, dataset, observed, current_port`;
app.get('/api/yachts/latest', async (req, res) => {
  if (deniedRaw(req, res)) return;
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (mmsi) ${LATEST_COLUMNS}
      FROM positions
      WHERE dataset = $1
      ORDER BY mmsi, timestamp DESC
    `, [CFG.dataset]);
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
});

// Historical data for a yacht
// Bisherige Aufrufe (?period=day|week|month) liefern unverändert ein Array.
// Neu: period=year, mode=rolling|calendar, from/to (siehe lib/periods.js);
// meta=1 → { meta, points }; max_points=N → zeitliche Buckets für die Anzeige.
app.get('/api/yacht/:mmsi/history', async (req, res) => {
  try {
    const { mmsi } = req.params;
    if (!/^\d{9}$/.test(mmsi)) return res.status(400).json({ error: 'mmsi must have 9 digits' });
    const win = resolveWindow(req.query);
    const maxPoints = Math.min(Math.max(Number(req.query.max_points) || 0, 0), 5000);
    const pub = publicView(req);
    const h = await dash.history(mmsi, win, maxPoints, { minBucketS: pub ? PUBLIC_MIN_BUCKET_S : 0 });
    if (pub) h.points = h.points.map(({ latitude, longitude, speed_knots, ...rest }) => rest);
    if (!wantsMeta(req)) return res.json(h.points);
    const range = await dash.yachtRange(mmsi);
    res.json({
      meta: { mmsi, ...windowMeta(win), ...range, points_raw: h.points_raw,
              downsampled: h.bucket_s > 0, bucket_s: h.bucket_s },
      points: h.points,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Öffentliche Fehlerantworten ohne interne Details (SQL o. ä.); Details nur ins Log (Prüfbericht H2)
function serverError(res, err) {
  console.error('[API]', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  res.status(500).json({ error: 'internal error' });
}

const wantsMeta = (req) => req.query.meta === '1' || req.query.meta === 'true';
const windowMeta = (win) => ({ window_from: win.t0.toISOString(), window_to: win.t1.toISOString(),
  period: win.period, mode: win.mode, period_h: win.period_h });
function sendError(res, err) {
  if (err instanceof WindowError) return res.status(400).json({ error: err.message });
  serverError(res, err);
}

// ── ZEITINTEGRATION ──────────────────────────────────────────────────────────
// Rechnung und Regeln (Liegezeit A32, Liegezustände Hafen/Werft/Anker/Lay-up): lib/integrate.js.
// Orte: data/ports.csv, data/yards.csv (lib/zones.js); belegte Lay-ups: data/tracking_state.csv.
const stays = require('./lib/integrate');
const { loadZones } = require('./lib/zones');
const { listStays, CLUSTER_SM } = require('./lib/staylist');
const STAY = stays.stayParams();          // beim Start geprüft
const ZONES = loadZones();                // fehlerhafte CSV → Start schlägt fehl (CI fängt es ab)

async function integrateEmissions(win) {
  return stays.integrateEmissions(pool, win, {
    dataset: CFG.dataset, params: STAY, zones: ZONES, evidence: tracking.layupEvidence(),
    fleetMmsi: YACHTS.map(y => y.mmsi),
  });
}

// Cumulative emissions per yacht for a period (zeitgewichtet integriert)
// Bisherige Aufrufe (?period=day|week|month) liefern unverändert ein Array.
// Neu: period=year, mode, from/to; meta=1 → { meta, rows } mit Datenbereich.
// Ergebnisse 60 s zwischengespeichert (Daten kommen nur wenige Male am Tag hinzu).
app.get('/api/emissions/summary', async (req, res) => {
  try {
    const fresh = resolveWindow(req.query);      // prüft Parameter auch bei Cache-Treffer
    const { win, rows } = await dash.cache(`sum:${CFG.dataset}:${windowKey(req.query)}`,
      async () => ({ win: fresh, rows: await integrateEmissions(fresh) }));
    if (!wantsMeta(req)) return res.json(rows);
    const range = await dash.dataRange();
    res.json({
      meta: { ...windowMeta(win), ...range, dataset: CFG.dataset, calc_version: CALC_VERSION,
              yachts_tracked: YACHTS.length, yachts_with_data: rows.length,
              ...stays.stayMeta(STAY, ZONES),
              visibility: req.ownerView },
      rows: rows.map(r => ({ ...r, flag_code: dash.flagCode(r.flag), category: 'yacht' })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Flotte mit Stammdaten (Belegstatus je Feld) und Datenbereich – Grundlage für Leerzustand,
// Filter und Detailansicht. Eigentümerfelder setzt die Maskierung.
app.get('/api/fleet', async (req, res) => {
  try {
    let [yachts, range] = await Promise.all([dash.fleet(), dash.dataRange()]);
    if (publicView(req)) {
      // ohne letzte Position und ohne Anbieter-Stammdaten (Rohdaten); Kopien, der Cache bleibt unverändert
      yachts = yachts.map(({ last_position, ...y }) => ({ ...y, last_position: null,
        fields: y.fields.filter(f => f.status !== 'provider') }));
    }
    res.json({
      meta: { ...range, dataset: CFG.dataset, provider: CFG.provider, calc_version: CALC_VERSION,
              yachts_tracked: YACHTS.length, visibility: req.ownerView, server_time: new Date().toISOString() },
      yachts,
    });
  } catch (err) {
    sendError(res, err);
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
             COUNT(*) FILTER (WHERE history_status = 'invalid')::int AS history_invalid,
             COUNT(*) FILTER (WHERE moved)::int                    AS detected_moved,
             -- Kontrolle der Erkennung an Tagen mit Historie
             COUNT(*) FILTER (WHERE history_moved AND moved)::int      AS hist_moved_detected,
             COUNT(*) FILTER (WHERE history_moved AND NOT moved)::int  AS hist_moved_missed,
             -- Plausibilität (15.11.2026): leere Historie und Bewegung laut Live-Abruf widersprechen sich
             COUNT(*) FILTER (WHERE history_status = 'empty')::int     AS history_empty,
             COUNT(*) FILTER (WHERE moved AND history_status = 'empty')::int AS moved_but_empty,
             MAX(updated_at) AS last_update
        FROM vessel_days WHERE dataset = $1 AND day > (NOW() AT TIME ZONE 'UTC')::date - 30`, [CFG.dataset]);
    res.json({ provider: CFG.provider, dataset: CFG.dataset, dry_run: CFG.dryRun,
               schedule: provider ? computeSchedule(CFG, YACHTS.length, provider.COSTS) : null,
               history_hour_utc: CFG.historyHourUtc, history_timegroup_min: CFG.timegroupMin,
               history_lookback_days: CFG.lookbackDays,
               backfill: { days: CFG.backfillDays, from: CFG.backfillFrom, order: CFG.backfillOrder, tail_days: CFG.backfillTailDays },
               credits: st, last_30_days: days.rows[0] });
  } catch (err) {
    serverError(res, err);
  }
});

// ── IDENTITÄTSABGLEICH (öffentlich, nur lesend; keine Eigentümer) ────────────
// Letzter Abgleich IMO ↔ MMSI je Yacht, Problemfälle zuerst (lib/identity.js).
app.get('/api/identity', async (req, res) => {
  if (deniedRaw(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ interval_days: IDENTITY_CHECK_DAYS, ...(await identity.latest(pool, CFG.dataset)) });
  } catch (err) { serverError(res, err); }
});

// Prüfliste: Unstimmigkeiten (MMSI, keine frische Meldung, fällige Pausen), die eine
// Web-Recherche auslösen; dazu die aktuellen Pausen (lib/tracking.js). Ohne Eigentümer.
app.get('/api/review', async (req, res) => {
  if (deniedRaw(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await tracking.review(pool, CFG.dataset, { identityLatest: await identity.latest(pool, CFG.dataset) }));
  } catch (err) { serverError(res, err); }
});

// Liegeorte aus den eigenen Daten (lib/staylist.js): Grundlage für data/ports.csv und data/yards.csv.
// Nur mit Zugang (enthält Positionen = Rohdaten). ?min_hours=72 (Standard)
app.get('/api/stays', async (req, res) => {
  if (deniedRaw(req, res)) return;
  try {
    const minHours = Math.max(1, Math.min(Number(req.query.min_hours) || STAY.yardMinHours, 24 * 365));
    res.set('Cache-Control', 'no-store');
    const places = await listStays(pool, { dataset: CFG.dataset, zones: ZONES, minHours,
      vKn: STAY.stationaryVKn, distSm: STAY.stationaryDistSm });
    res.json({ dataset: CFG.dataset, min_hours: minHours, cluster_sm: CLUSTER_SM,
      csv_header: 'name;lat;lon;radius_sm;source_url;note', places });
  } catch (err) { serverError(res, err); }
});

// ── ADMIN (nur mit ADMIN_TOKEN; ohne Variable deaktiviert) ───────────────────
// Schutz: konstanter Zeitvergleich, Fehlversuche je IP begrenzt (lib/security.js).
// Admin-Seite: public/admin/ ; Admin-API: /admin/api/* (lib/admin.js)
mountAdmin(app, { pool, store: ownerStore, YACHTS, requireAdmin, CFG });

// Plan ansehen, ohne Credits auszugeben: /admin/plan?lookback=14&backfill=true
app.get('/admin/plan', requireAdmin, async (req, res) => {
  try {
    const provider = getProvider();
    if (!provider) return res.status(400).json({ error: 'AIS_PROVIDER=none' });
    const plan = await planner.planHistory(pool, provider, CFG, {
      lookbackDays: Number(req.query.lookback) || CFG.lookbackDays, backfill: req.query.backfill === 'true' });
    res.json({ ...plan, skipped: plan.skipped.length, backfill_calls: (plan.backfill_calls || []).length, selected: plan.selected.map(c => `${c.day} ${c.name} P${c.prio} (${c.why})`) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/admin/identity', requireAdmin, async (_, res) => {
  try { res.json(await runJob('identity')); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/admin/poll', requireAdmin, async (_, res) => {
  try { res.json(await runJob('poll')); } catch (err) { res.status(500).json({ error: err.message }); }
});
// Historie jetzt abrufen; ?lookback=14&backfill=true für den Startbestand
app.post('/admin/history', requireAdmin, async (req, res) => {
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
    const r = kind === 'poll' ? await planner.pollLive(pool, provider, CFG, { extended: opts.extended })
      : kind === 'identity' ? await identity.run(pool, provider, CFG, { yachts: YACHTS })
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
  // Identitätsabgleich: täglich 02:41 UTC nachsehen, ob er fällig ist (alle IDENTITY_CHECK_DAYS Tage),
  // und 2 min nach dem Start (holt einen versäumten Lauf nach, z. B. nach Neustart oder beim ersten Deploy)
  const identityIfDue = async (why) => {
    try {
      const last = await identity.lastRunAt(pool, CFG.dataset);
      if (last && Date.now() - last.getTime() < (IDENTITY_CHECK_DAYS - 0.5) * 86400000) return;
      const r = await runJob('identity');
      console.log(`[IDENTITÄT] ${why}`, JSON.stringify(r).slice(0, 400));
      if (r && r.skipped === 'anderer Abruf läuft') setTimeout(() => identityIfDue('Wiederholung'), 600000);
    } catch (e) { console.error('[IDENTITÄT]', e.message); }
  };
  cron.schedule('41 2 * * *', () => identityIfDue('planmäßig'), { timezone: 'Etc/UTC' });
  setTimeout(() => identityIfDue('nach Start'), 120000);
  console.log(`[ABRUF] ${CFG.provider} (${CFG.dataset}${CFG.dryRun ? ', dry-run' : ''}): ${YACHTS.length} Yachten, ` +
    `Live ${sch.polls_per_day}×/Tag (${hours} UTC, extended ${sch.extended_hour_utc}), Historie ${CFG.historyHourUtc}:23 UTC ` +
    `${provider.HISTORY ? `(Positionsänderungen, bis ${daysPerHistoryCall(CFG, provider)} Tage je Abfrage)` : `im ${CFG.timegroupMin}-min-Raster`}, ` +
    `Plan ${sch.projected_month_31d} Credits/31 Tage (${sch.share_pct} %)`);
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

// Unbekannte API-Pfade: JSON statt HTML
app.use(['/api', '/admin/api'], (req, res) => res.status(404).json({ error: 'not found' }));

setupWithRetry().then(() => {
 // connectAIS();
  console.log(`[ACCESS] Seite ${siteMode() === 'public' ? 'ÖFFENTLICH (SITE_ACCESS=public)' : 'PRIVAT (nur mit Zugang; öffnen mit SITE_ACCESS=public)'}`);
  if (!process.env.ADMIN_TOKEN) console.log('[ADMIN] ADMIN_TOKEN nicht gesetzt – Admin-Seite und Admin-API deaktiviert');
  else if (process.env.ADMIN_TOKEN.length < 24) console.warn('[ADMIN] ADMIN_TOKEN kürzer als 24 Zeichen – bitte länger wählen');
  startScheduler();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
  
