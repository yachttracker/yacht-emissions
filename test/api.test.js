// ── API-Tests (node:test, keine zusätzlichen Pakete) ─────────────────────────
// Startet server.js gegen DATABASE_URL mit eigenem Datensatz (AIS_DATASET=citest),
// legt synthetische Messpunkte an und prüft:
//   1. bisherige Summary-Aufrufe = Referenz-SQL von main (ffd0b6d), Zahlen identisch
//   2. neue Zeitfenster (year, calendar, from/to) und Vorrang der Historie
//   3. Eigentümer-Maskierung: bei "aus" steht kein Name in irgendeiner API-Antwort
//   4. Admin-Schutz (Token, Fehlversuche), statische Auslieferung
// Lauf: DATABASE_URL=... DATABASE_SSL=false node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');

const PORT = Number(process.env.TEST_PORT) || 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ci-admin-token-0123456789abcdef';
const DATASET = 'citest';
const A = '319225400';   // Koru (fleet.js)
const B = '538072122';   // Launchpad (fleet.js)
const OWNER_A = 'Testa Fictional';
const OWNER_B = 'Hidden Unverified';
const SOURCE_A = 'https://example.org/ownership-proof-a';
const LEGACY = 'Legacy Leak Name';

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
let server;

// Referenz: integrateEmissions aus main (Commit ffd0b6d), unverändert übernommen
const REFERENCE_SQL = `
    WITH bounds AS (
      SELECT NOW() - make_interval(hours => $1) AS t0,
             NOW()                              AS t1,
             make_interval(hours => $2)          AS max_gap,
             make_interval(hours => $3)          AS max_gap_hist
    ),
    pts AS (
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
    ORDER BY co2_kg_total DESC`;

async function get(p, headers = {}) {
  const r = await fetch(BASE + p, { headers, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: r.status, text, json, headers: r.headers };
}
async function send(method, p, body, token = TOKEN) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AIS_DATASET: DATASET, ADMIN_TOKEN: TOKEN, AIS_PROVIDER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; ; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch { /* startet noch */ }
    if (i > 80) throw new Error('Server startet nicht:\n' + log);
    await new Promise(r => setTimeout(r, 250));
  }
  // Testdaten (nur Datensatz citest)
  await pool.query(`DELETE FROM positions WHERE dataset = $1`, [DATASET]);
  await pool.query(`DELETE FROM vessel_days WHERE dataset = $1`, [DATASET]);
  await pool.query(`DELETE FROM vessel_owner WHERE mmsi IN ($1, $2)`, [A, B]);
  await pool.query(`UPDATE app_settings SET value = 'false'::jsonb WHERE key = 'owner_names_visible'`);
  // Yacht A: live alle 30 min, 60 h zurück, konstante Raten (CO₂ 100 kg/h)
  await pool.query(`
    INSERT INTO positions (mmsi, name, owner, flag, length_m, latitude, longitude, speed_knots,
                           co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp, source, dataset)
    SELECT $1, 'Koru', $3, '🇰🇾', 127, 43.5, 7.2 + g * 0.001, 0.1, 100, 2, 0.2, 31.19,
           NOW() - make_interval(mins => g * 30), 'live', $2
      FROM generate_series(1, 120) g`, [A, DATASET, LEGACY]);
  // Yacht B: gestern UTC Historie alle 5 min (CO₂ 50 kg/h) + Live-Punkte mit 999 kg/h,
  // Tag als "Historie erledigt" markiert → nur Historie zählt
  const d = yesterday();
  await pool.query(`
    INSERT INTO positions (mmsi, name, owner, flag, length_m, latitude, longitude, speed_knots,
                           co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp, source, dataset)
    SELECT $1, 'Launchpad', $4, '🇲🇭', 118, 43.7, 7.4, 0.1, 50, 1, 0.1, 15.6,
           (($3::date)::timestamp AT TIME ZONE 'UTC') + make_interval(mins => g * 5), 'history', $2
      FROM generate_series(0, 287) g`, [B, DATASET, d, LEGACY]);
  await pool.query(`
    INSERT INTO positions (mmsi, name, owner, flag, length_m, latitude, longitude, speed_knots,
                           co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp, source, dataset)
    SELECT $1, 'Launchpad', $4, '🇲🇭', 118, 43.7, 7.4, 12, 999, 20, 2, 311.6,
           (($3::date)::timestamp AT TIME ZONE 'UTC') + make_interval(mins => g * 60 + 7), 'live', $2
      FROM generate_series(0, 23) g`, [B, DATASET, d, LEGACY]);
  await pool.query(`INSERT INTO vessel_days (dataset, mmsi, day, history_status) VALUES ($1, $2, $3::date, 'done')`,
    [DATASET, B, d]);
});

after(async () => {
  if (server) server.kill();
  await pool.query(`DELETE FROM positions WHERE dataset = $1`, [DATASET]).catch(() => {});
  await pool.query(`DELETE FROM vessel_days WHERE dataset = $1`, [DATASET]).catch(() => {});
  await pool.query(`DELETE FROM vessel_owner WHERE mmsi IN ($1, $2)`, [A, B]).catch(() => {});
  await pool.query(`DELETE FROM share_keys WHERE label LIKE 'ci-%'`).catch(() => {});
  await pool.query(`UPDATE app_settings SET value = 'false'::jsonb WHERE key = 'owner_names_visible'`).catch(() => {});
  await pool.end();
});

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('bisherige Summary-Aufrufe liefern die Zahlen der Referenz (main)', async () => {
  for (const [period, h] of [['day', 24], ['week', 168], ['month', 720]]) {
    const r = await get(`/api/emissions/summary?period=${period}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), 'Antwort bleibt ein Array');
    const ref = (await pool.query(REFERENCE_SQL, [h, 7, 1, DATASET])).rows;
    assert.equal(r.json.length, ref.length, `${period}: Anzahl Yachten`);
    for (const x of ref) {
      const y = r.json.find(z => z.mmsi === x.mmsi);
      assert.ok(y, `${period}: ${x.mmsi} fehlt`);
      for (const k of ['co2_kg_total', 'fuel_kg_total', 'nox_kg_total', 'sox_kg_total', 'coverage_h', 'coverage_history_h']) {
        close(Number(y[k]), Number(x[k]), k.startsWith('coverage') ? 0.02 : 1, `${period} ${x.mmsi} ${k}`);
      }
      assert.equal(Number(y.period_h), h);
      assert.equal(y.data_points, x.data_points, `${period} ${x.mmsi} data_points`);
      assert.equal(y.name, x.name);
    }
  }
  // Tag rollierend: Yacht A durchgehend abgedeckt → 24 h × 100 kg/h
  const day = (await get('/api/emissions/summary?period=day')).json.find(z => z.mmsi === A);
  close(day.co2_kg_total, 2400, 1, 'A Tag CO₂');
  close(day.coverage_h, 24, 0.02, 'A Tag Abdeckung');
});

test('freies Fenster: Historie hat Vorrang, Live-Punkte des Tages zählen nicht', async () => {
  const d = yesterday();
  const r = await get(`/api/emissions/summary?from=${d}&to=${d}&meta=1`);
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.period, 'custom');
  assert.equal(r.json.meta.window_from, `${d}T00:00:00.000Z`);
  assert.equal(r.json.meta.period_h, 24);
  const b = r.json.rows.find(z => z.mmsi === B);
  assert.equal(b.co2_kg_total, 1200);
  assert.equal(b.coverage_h, 24);
  assert.equal(b.coverage_history_h, 24);
  assert.equal(b.category, 'yacht');
  assert.equal(b.flag_code, 'MH');
  assert.ok(r.json.meta.data_from && r.json.meta.data_to, 'Datenbereich vorhanden');
});

test('neue Zeitfenster: year und calendar', async () => {
  const y = await get('/api/emissions/summary?period=year&meta=1');
  assert.equal(y.json.meta.period_h, 8760);
  assert.equal(y.json.meta.mode, 'rolling');
  const a = y.json.rows.find(z => z.mmsi === A);
  close(a.coverage_h, 60, 0.05, 'A Jahr Abdeckung = Datenbereich');
  const now = new Date();
  for (const [period, start] of [
    ['day', Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())],
    ['month', Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)],
    ['year', Date.UTC(now.getUTCFullYear(), 0, 1)],
  ]) {
    const c = await get(`/api/emissions/summary?period=${period}&mode=calendar&meta=1`);
    assert.equal(c.status, 200);
    assert.equal(c.json.meta.mode, 'calendar');
    assert.equal(c.json.meta.window_from, new Date(start).toISOString(), `${period} Kalenderbeginn`);
  }
  const w = await get('/api/emissions/summary?period=week&mode=calendar&meta=1');
  assert.equal(new Date(w.json.meta.window_from).getUTCDay(), 1, 'Woche beginnt Montag');
  for (const bad of ['from=2026-02-30', 'from=2026-01-01T10:00', 'to=2026-01-01', 'from=2020-01-01&to=2026-01-01']) {
    assert.equal((await get(`/api/emissions/summary?${bad}`)).status, 400, bad);
  }
});

test('History: Fenster, Metadaten, Verdichtung für die Anzeige', async () => {
  const legacy = await get(`/api/yacht/${A}/history?period=day`);
  assert.ok(Array.isArray(legacy.json));
  assert.equal(legacy.json.length, 47, 'Punkte in (jetzt − 24 h, jetzt]');
  const m = await get(`/api/yacht/${A}/history?period=week&meta=1&max_points=20`);
  assert.equal(m.json.meta.points_raw, 120);
  assert.equal(m.json.meta.downsampled, true);
  assert.ok(m.json.points.length <= 21 && m.json.points.length > 0);
  const hb = await get(`/api/yacht/${B}/history?period=week`);
  assert.ok(hb.json.every(p => p.source === 'history'), 'B: an Historientagen nur Historie');
  assert.equal((await get('/api/yacht/123/history')).status, 400);
});

test('Maskierung: Name verlässt den Server nicht, solange die Sichtbarkeit aus ist', async () => {
  let r = await send('PUT', `/admin/api/vessels/${A}/owner`, { name: OWNER_A, source_url: SOURCE_A, status: 'sourced' });
  assert.equal(r.status, 200);
  assert.match(r.json.alias, /^Owner \d{2,4}$/);
  const alias = r.json.alias;
  r = await send('PUT', `/admin/api/vessels/${B}/owner`, { name: OWNER_B, status: 'unverified' });
  assert.equal(r.status, 200);
  assert.equal((await send('PUT', `/admin/api/vessels/${B}/owner`, { name: OWNER_B, status: 'sourced' })).status, 400,
    'sourced ohne Quelle abgelehnt');

  const paths = ['/api/fleet', '/api/emissions/summary?period=day', '/api/emissions/summary?period=week&meta=1',
    '/api/yachts/latest', `/api/yacht/${A}/history?meta=1`, `/api/yacht/${B}/history?period=week&meta=1`, '/api/status',
    `/api/emissions/summary?from=${yesterday()}&meta=1`];
  for (const p of paths) {
    const x = await get(p);
    assert.equal(x.status, 200, p);
    for (const secret of [OWNER_A, OWNER_B, SOURCE_A, LEGACY]) {
      assert.ok(!x.text.includes(secret), `${p} enthält "${secret}"`);
    }
    assert.equal(x.headers.get('cache-control'), 'no-store', `${p} no-store`);
  }
  const s = (await get('/api/emissions/summary?period=week&meta=1')).json;
  assert.equal(s.meta.visibility.reveal, false);
  const a = s.rows.find(z => z.mmsi === A), b = s.rows.find(z => z.mmsi === B);
  assert.equal(a.owner, alias);
  assert.equal(a.owner_masked, true);
  assert.equal(a.owner_source_url, null);
  assert.equal(b.owner, 'Owner unknown', 'ungeprüfte Zuordnung ohne Alias');
});

test('Sichtbarkeit global und per Share-Link', async () => {
  assert.equal((await send('PUT', '/admin/api/settings', { owner_names_visible: true })).status, 200);
  let x = await get('/api/emissions/summary?period=week&meta=1');
  assert.ok(x.text.includes(OWNER_A), 'Name sichtbar');
  assert.ok(x.text.includes(SOURCE_A), 'Quelle sichtbar');
  assert.ok(!x.text.includes(OWNER_B), 'ungeprüfter Name bleibt verborgen');
  assert.ok(!x.text.includes(LEGACY));
  assert.equal(x.json.meta.visibility.via, 'global');

  await send('PUT', '/admin/api/settings', { owner_names_visible: false });
  const k = await send('POST', '/admin/api/share-keys', { label: 'ci-prof' });
  assert.equal(k.status, 201);
  assert.ok(k.json.key.length >= 40);
  x = await get('/api/emissions/summary?period=week&meta=1', { 'x-share-key': k.json.key });
  assert.ok(x.text.includes(OWNER_A), 'Share-Link zeigt Namen');
  assert.equal(x.json.meta.visibility.via, 'share_key');
  x = await get('/api/emissions/summary?period=week&meta=1', { 'x-share-key': 'x'.repeat(43) });
  assert.ok(!x.text.includes(OWNER_A));
  assert.equal(x.json.meta.visibility.share_key, 'invalid');
  const st = await send('GET', '/admin/api/state');
  assert.ok(!JSON.stringify(st.json).includes(k.json.key), 'Schlüssel wird nicht im Klartext gespeichert/gelistet');
  assert.equal((await send('POST', `/admin/api/share-keys/${k.json.id}/revoke`)).json.revoked, 1);
  x = await get('/api/emissions/summary?period=week&meta=1', { 'x-share-key': k.json.key });
  assert.ok(!x.text.includes(OWNER_A), 'widerrufener Link zeigt keine Namen');
});

test('Statische Seiten und unbekannte API-Pfade', async () => {
  const idx = await get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  const adm = await get('/admin');
  assert.ok([301, 302, 303].includes(adm.status), 'Redirect /admin → /admin/');
  assert.equal((await get('/admin/')).status, 200);
  const nf = await get('/api/does-not-exist');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error, 'not found');
});

test('Admin-Schutz: Token nötig, Fehlversuche werden gebremst', async () => {
  assert.equal((await send('GET', '/admin/api/state', undefined, '')).status, 403);
  assert.equal((await send('GET', '/admin/api/state', undefined, 'wrong')).status, 403);
  let last;
  for (let i = 0; i < 10; i++) last = await send('GET', '/admin/api/state', undefined, 'wrong');
  assert.equal(last.status, 429);
  assert.equal((await send('GET', '/admin/api/state')).status, 429, 'auch mit richtigem Token gesperrt');
});
