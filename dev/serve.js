// ── Lokaler Dev-Server mit Mock-API (ohne Abhängigkeiten, ohne Datenbank) ────
// Liefert public/ aus und beantwortet die API-Endpunkte mit erfundenen Daten
// (dev/mock/fleet.json). Nur für die Entwicklung – auf Railway läuft server.js.
//   node dev/serve.js            → http://localhost:5173
//   PORT=8080 node dev/serve.js
// Admin-Seite: http://localhost:5173/admin/  (Token: DEV_ADMIN_TOKEN, Standard "dev-admin-token")
// Mock-Werte: Raten aus emissions.js, Positionen/Fahrten zufällig, aber reproduzierbar.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveWindow, WindowError } = require('../lib/periods');
const { maskPayload } = require('../lib/owners');
const { calcHourlyEmissions, CALC_VERSION } = require('../emissions');

const PORT = Number(process.env.PORT) || 5173;
const ADMIN_TOKEN = process.env.DEV_ADMIN_TOKEN || 'dev-admin-token';
const PUBLIC = path.join(__dirname, '..', 'public');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock', 'fleet.json'), 'utf8'));
const MAX_GAP_H = 7, MAX_GAP_HIST_H = 1;
const H = 3600000, DAY = 24 * H;
const DATA_DAYS = 200;   // Messreihe beginnt vor 200 Tagen → "Year" zeigt den bisherigen Stand

// ── Erfundene Messpunkte ────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const hash = (str) => { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const distNm = (a, b) => {
  const R = 3440.065, r = (x) => x * Math.PI / 180;
  const dl = r(b[0] - a[0]), dn = r(b[1] - a[1]);
  const q = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

const NOW = Date.now();
const positions = new Map();   // mmsi → [{t, lat, lon, sog, co2, fuel, nox, sox, source}]
for (const y of FIX.yachts) {
  const pts = [];
  positions.set(y.mmsi, pts);
  if (y.no_data) continue;
  const rand = rng(hash(y.mmsi));
  const ports = FIX.regions[y.region];
  let port = ports[Math.floor(rand() * ports.length)];
  const end = NOW - (y.stop_days_ago || 0) * DAY;
  let t = Math.floor((NOW - DATA_DAYS * DAY) / H) * H;
  let trip = null, gapUntil = 0;
  const covTarget = y.coverage || 0.93;
  while (t <= end) {
    if (!trip && rand() < 0.012) {                    // ~ alle 3–4 Tage eine Fahrt
      let dest = ports[Math.floor(rand() * ports.length)];
      if (dest === port) dest = ports[(ports.indexOf(port) + 1) % ports.length];
      const kn = 10 + rand() * 6;
      trip = { from: port, to: dest, kn, start: t, dur: Math.max(1, Math.min(36, distNm(port, dest) / kn)) * H };
    }
    if (t >= gapUntil && rand() < (1 - covTarget) / 12) gapUntil = t + (8 + rand() * 40) * H;   // AIS-Lücke
    let lat, lon, sog, nav;
    if (trip) {
      const f = (t - trip.start) / trip.dur;
      if (f >= 1) { port = trip.to; trip = null; [lat, lon] = port; sog = 0.1; nav = 5; }
      else { lat = trip.from[0] + (trip.to[0] - trip.from[0]) * f; lon = trip.from[1] + (trip.to[1] - trip.from[1]) * f; sog = trip.kn; nav = 0; }
    } else { [lat, lon] = port; lat += (rand() - 0.5) * 0.004; lon += (rand() - 0.5) * 0.004; sog = 0.1; nav = rand() < 0.5 ? 1 : 5; }
    if (t >= gapUntil) {
      const em = calcHourlyEmissions({ length: y.length }, sog, nav);
      pts.push({ t, lat, lon, sog, co2: em.co2_kg_h, fuel: em.fuel_kg_h, nox: em.nox_kg_h, sox: em.sox_kg_h,
                 source: t < NOW - 2 * DAY ? 'history' : 'live', mcr: em.mcr_kw });
    }
    t += trip ? H / 2 : H;   // in Fahrt dichter
  }
}

// ── Eigentümer, Sichtbarkeit, Share-Links (im Speicher) ─────────────────────
const aliases = new Map();
const owners = new Map();      // mmsi → { name, alias, status, source_url }
const usedAlias = new Set();
const aliasFor = (name) => {
  if (aliases.has(name)) return aliases.get(name);
  let a; do { a = `Owner ${String(1 + crypto.randomInt(99)).padStart(2, '0')}`; } while (usedAlias.has(a));
  usedAlias.add(a); aliases.set(name, a); return a;
};
for (const y of FIX.yachts) if (y.owner) owners.set(y.mmsi, { ...y.owner, alias: aliasFor(y.owner.name) });
let visible = false;
const shareKeys = [];          // { id, label, hash, created_at, revoked_at, last_used_at }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const store = {
  link: (mmsi) => { const o = owners.get(String(mmsi)); return o ? { ...o } : null; },
  forbiddenNames: (reveal) => {
    const all = [...new Set([...owners.values()].map(o => o.name))];
    if (!reveal) return all;
    const shown = new Set([...owners.values()].filter(o => o.status === 'sourced' && o.source_url).map(o => o.name));
    return all.filter(n => !shown.has(n));
  },
};
function view(req) {
  const key = req.headers['x-share-key'];
  const k = key ? shareKeys.find(x => !x.revoked_at && x.hash === sha(key)) : null;
  if (k) k.last_used_at = new Date().toISOString();
  const reveal = visible || !!k;
  return { reveal, via: visible ? 'global' : k ? 'share_key' : 'masked', share_key: key ? (k ? 'valid' : 'invalid') : 'none' };
}

// ── Berechnung wie im Backend (Zeitintegration, Lückengrenze) ───────────────
function integrate(win) {
  const t0 = win.t0.getTime(), t1 = win.t1.getTime();
  const rows = [];
  for (const y of FIX.yachts) {
    const pts = positions.get(y.mmsi).filter(p => p.t > t0 - MAX_GAP_H * H && p.t <= t1);
    let co2 = 0, fuel = 0, nox = 0, sox = 0, cov = 0, covHist = 0, n = 0, last = null;
    pts.forEach((p, i) => {
      const next = pts[i + 1];
      const gap = (p.source === 'history' ? MAX_GAP_HIST_H : MAX_GAP_H) * H;
      const dt = Math.max(0, Math.min(next ? next.t : t1, p.t + gap, t1) - Math.max(p.t, t0)) / H;
      co2 += p.co2 * dt; fuel += p.fuel * dt; nox += p.nox * dt; sox += p.sox * dt; cov += dt;
      if (p.source === 'history') covHist += dt;
      if (p.t > t0) n++;
      last = p.t;
    });
    if (cov > 0) rows.push({ mmsi: y.mmsi, name: y.name, flag: y.flag, flag_code: y.flag, length_m: y.length, category: 'yacht',
      co2_kg_total: +co2.toFixed(1), fuel_kg_total: +fuel.toFixed(1), nox_kg_total: +nox.toFixed(1), sox_kg_total: +sox.toFixed(2),
      coverage_h: +cov.toFixed(2), coverage_history_h: +covHist.toFixed(2), period_h: win.period_h, data_points: n,
      last_seen: new Date(last).toISOString() });
  }
  return rows.sort((a, b) => b.co2_kg_total - a.co2_kg_total);
}
function dataRange() {
  let a = Infinity, b = -Infinity;
  for (const pts of positions.values()) for (const p of pts) { if (p.t < a) a = p.t; if (p.t > b) b = p.t; }
  if (!Number.isFinite(a)) return { data_from: null, data_to: null };
  return { data_from: new Date(a).toISOString(), data_to: new Date(b).toISOString() };
}
const RANGE = dataRange();
const windowMeta = (w) => ({ window_from: w.t0.toISOString(), window_to: w.t1.toISOString(), period: w.period, mode: w.mode, period_h: w.period_h });
const fieldsFor = (y, last) => [
  { key: 'name', label: 'Name', value: y.name, status: 'unverified', note: 'Invented demo yacht' },
  { key: 'mmsi', label: 'MMSI', value: y.mmsi, status: 'unverified', note: 'Invented identifier' },
  { key: 'flag', label: 'Flag', value: y.flag, status: 'unverified', note: 'Invented' },
  { key: 'length_m', label: 'Length', value: y.length, unit: 'm', status: 'unverified', note: 'Invented' },
  ...(last ? [{ key: 'mcr_kw', label: 'Engine power (MCR)', value: Math.round(last.mcr), unit: 'kW', status: 'assumption', note: 'Estimated from length (no source) until researched' }] : []),
  { key: 'gt', label: 'Gross tonnage', value: Math.round(y.length ** 2.1 / 3), unit: 'GT', status: 'provider', note: 'Provider data (demo)' },
  { key: 'built', label: 'Year built', value: 2008 + (hash(y.mmsi) % 17), status: 'provider', note: 'Provider data (demo)' },
];

// ── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function sendJson(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }
function serveStatic(req, res, p) {
  let file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  const q = Object.fromEntries(u.searchParams);
  try {
    if (p === '/health') return sendJson(res, 200, { status: 'ok', calc_version: CALC_VERSION });
    if (p.startsWith('/api/')) {
      const v = view(req);
      const out = (body) => sendJson(res, 200, maskPayload(body, store, v.reveal));
      if (p === '/api/status') return out({ provider: 'mock', dataset: 'demo', dry_run: false, schedule: null,
        credits: null, last_30_days: { last_update: RANGE.data_to } });
      if (p === '/api/fleet') {
        const yachts = FIX.yachts.map(y => {
          const pts = positions.get(y.mmsi), last = pts[pts.length - 1];
          return { mmsi: y.mmsi, name: y.name, category: 'yacht', flag: y.flag, flag_code: y.flag, length_m: y.length,
            propulsion: null, build_year: null, gt: null, last_seen: last ? new Date(last.t).toISOString() : null,
            last_position: last ? { lat: last.lat, lon: last.lon, speed_knots: last.sog, source: last.source } : null,
            fields: fieldsFor(y, last) };
        });
        return out({ meta: { ...RANGE, dataset: 'demo', provider: 'mock', calc_version: CALC_VERSION,
          yachts_tracked: yachts.length, visibility: v, server_time: new Date().toISOString() }, yachts });
      }
      if (p === '/api/emissions/summary') {
        const w = resolveWindow(q);
        const rows = integrate(w);
        if (!(q.meta === '1')) return out(rows);
        return out({ meta: { ...windowMeta(w), ...RANGE, dataset: 'demo', calc_version: CALC_VERSION, yachts_tracked: FIX.yachts.length,
          yachts_with_data: rows.length, max_gap_hours: MAX_GAP_H, max_gap_hours_history: MAX_GAP_HIST_H, visibility: v }, rows });
      }
      const hm = /^\/api\/yacht\/(\d{9})\/history$/.exec(p);
      if (hm) {
        const w = resolveWindow(q);
        const all = (positions.get(hm[1]) || []).filter(x => x.t > w.t0.getTime() && x.t <= w.t1.getTime());
        const maxP = Number(q.max_points) || 0;
        let pts = all, bucket = 0;
        if (maxP && all.length > maxP) {
          bucket = Math.max(60, Math.ceil((w.t1 - w.t0) / 1000 / maxP));
          const groups = new Map();
          for (const x of all) { const k = Math.floor(x.t / 1000 / bucket); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
          pts = [...groups.values()].map(g => ({ t: g[0].t, lat: g[g.length - 1].lat, lon: g[g.length - 1].lon,
            sog: g.reduce((a, x) => a + x.sog, 0) / g.length, co2: g.reduce((a, x) => a + x.co2, 0) / g.length,
            fuel: g.reduce((a, x) => a + x.fuel, 0) / g.length, source: g[g.length - 1].source, n: g.length }));
        }
        const yp = positions.get(hm[1]) || [];
        return out({ meta: { mmsi: hm[1], ...windowMeta(w),
          data_from: yp.length ? new Date(yp[0].t).toISOString() : null, data_to: yp.length ? new Date(yp[yp.length - 1].t).toISOString() : null,
          points_raw: all.length, downsampled: bucket > 0, bucket_s: bucket },
        points: pts.map(x => ({ timestamp: new Date(x.t).toISOString(), latitude: x.lat, longitude: x.lon, speed_knots: x.sog,
          co2_kg_h: x.co2, fuel_kg_h: x.fuel, source: x.source, n: x.n })) });
      }
      if (p === '/api/yachts/latest') {
        return out(FIX.yachts.filter(y => positions.get(y.mmsi).length).map(y => {
          const x = positions.get(y.mmsi).slice(-1)[0];
          return { mmsi: y.mmsi, name: y.name, latitude: x.lat, longitude: x.lon, speed_knots: x.sog, co2_kg_h: x.co2,
            timestamp: new Date(x.t).toISOString(), source: x.source };
        }));
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    if (p.startsWith('/admin/api/')) {
      if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return sendJson(res, 403, { error: 'forbidden' });
      if (p === '/admin/api/state' && req.method === 'GET') {
        const allOwners = [...new Set([...owners.values()].map(o => o.name))].map((n, i) => ({ id: i + 1, alias: aliases.get(n), name: n }));
        return sendJson(res, 200, { dataset: 'demo', owner_names_visible: visible, settings_updated_at: null,
          share_keys: shareKeys.map(({ hash: _h, ...k }) => k), owners: allOwners,
          vessels: FIX.yachts.map(y => { const o = owners.get(y.mmsi);
            return { mmsi: y.mmsi, name: y.name, flag: y.flag, owner: o ? { mmsi: y.mmsi, alias: o.alias, name: o.name,
              source_url: o.source_url || null, status: o.status, note: o.note || null, updated_at: null } : null }; }) });
      }
      const body = await readBody(req);
      if (p === '/admin/api/settings' && req.method === 'PUT') {
        if (typeof body.owner_names_visible !== 'boolean') return sendJson(res, 400, { error: 'owner_names_visible must be true or false' });
        visible = body.owner_names_visible; return sendJson(res, 200, { owner_names_visible: visible });
      }
      if (p === '/admin/api/share-keys' && req.method === 'POST') {
        if (!body.label) return sendJson(res, 400, { error: 'label is required' });
        const key = crypto.randomBytes(32).toString('base64url');
        const k = { id: shareKeys.length + 1, label: String(body.label).slice(0, 100), hash: sha(key), created_at: new Date().toISOString(), revoked_at: null, last_used_at: null };
        shareKeys.push(k); return sendJson(res, 201, { id: k.id, label: k.label, created_at: k.created_at, key });
      }
      const rk = /^\/admin\/api\/share-keys\/(\d+)\/revoke$/.exec(p);
      if (rk && req.method === 'POST') {
        const k = shareKeys.find(x => x.id === Number(rk[1]) && !x.revoked_at);
        if (k) k.revoked_at = new Date().toISOString();
        return sendJson(res, 200, { revoked: k ? 1 : 0 });
      }
      const vo = /^\/admin\/api\/vessels\/(\d{9})\/owner$/.exec(p);
      if (vo && req.method === 'PUT') {
        const name = String(body.name || '').trim();
        if (name.length < 2) return sendJson(res, 400, { error: 'name: 2–200 characters' });
        if (body.status === 'sourced' && !body.source_url) return sendJson(res, 400, { error: 'status "sourced" requires a source URL' });
        const o = { name, status: body.status === 'sourced' ? 'sourced' : 'unverified', source_url: body.source_url || null, note: body.note || null, alias: aliasFor(name) };
        owners.set(vo[1], o); return sendJson(res, 200, { mmsi: vo[1], ...o });
      }
      if (vo && req.method === 'DELETE') { const had = owners.delete(vo[1]); return sendJson(res, 200, { removed: had ? 1 : 0 }); }
      return sendJson(res, 404, { error: 'not found' });
    }
    return serveStatic(req, res, p);
  } catch (err) {
    if (err instanceof WindowError) return sendJson(res, 400, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const n = [...positions.values()].reduce((a, x) => a + x.length, 0);
  console.log(`Dev-Server (DEMO-Daten, ${FIX.yachts.length} erfundene Yachten, ${n} Punkte): http://localhost:${PORT}`);
  console.log(`Admin-Seite: http://localhost:${PORT}/admin/  Token: ${ADMIN_TOKEN}`);
});
