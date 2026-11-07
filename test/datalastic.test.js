// Datalastic-Adapter ohne Netz und ohne Datenbank: fetch wird durch ein Test-Double ersetzt.
// Prüft Abfrageform (IMO, wiederholte Parameter, from/to statt days), Kostenheader, Zuordnung
// zur Flotten-MMSI, Navigationsstatus-Text → AIS-Code, Sortierung und Tagesfilter der Historie.
// Lauf: node --test test/datalastic.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DL_API_KEY = 'test-key';
process.env.DL_LOG_RAW = 'false';
const dl = require('../providers/datalastic');
const { YACHTS } = require('../fleet');
const { daysPerHistoryCall, computeSchedule } = require('../lib/schedule');
const { loadConfig } = require('../lib/config');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function respond(status, body, cost, extra = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (cost !== undefined) headers.set('x-request-cost', String(cost));
  return new Response(JSON.stringify(body), { status, headers });
}
const withImo = YACHTS.filter(y => /^\d{7}$/.test(String(y.imo)));

test('Bulk über IMO: Parameter wiederholt, Schlüssel im Header, Zuordnung zur Flotten-MMSI', async () => {
  const [a, b] = withImo;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url: new URL(url), key: opts.headers['x-api-key'] });
    return respond(200, { data: { total: 3, vessels: [
      // Yacht a unter neuer MMSI (Flaggenwechsel) und ein älterer Datensatz zur selben IMO
      { mmsi: '999000001', imo: a.imo, name: 'A', lat: 43.1, lon: 7.1, speed: 0.1, course: 10, heading: 20,
        navigation_status: 'At anchor', last_position_UTC: '2026-11-07T10:00:00Z', last_position_epoch: 1794045600 },
      { mmsi: a.mmsi, imo: a.imo, name: 'A alt', lat: 40, lon: 5, speed: 0, course: 0, heading: 0,
        navigation_status: 'Moored', last_position_UTC: '2024-01-01T00:00:00Z' },
      { mmsi: b.mmsi, imo: b.imo, name: 'B', lat: 25.2, lon: 55.3, speed: 12.4, course: 90, heading: 91,
        navigation_status: 'Under way using engine', last_position_UTC: '2026-11-07T09:55:00Z' },
    ] }, meta: { success: true } }, 3);
  };
  const r = await dl.fetchLive([a.mmsi, b.mmsi], { extended: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'test-key');
  assert.equal(seen[0].url.pathname, '/api/v0/vessel_bulk');
  assert.deepEqual(seen[0].url.searchParams.getAll('imo'), [String(a.imo), String(b.imo)]);
  assert.equal(seen[0].url.searchParams.get('api-key'), null, 'Schlüssel nie in der URL');
  assert.equal(r.charged, 3);
  assert.equal(r.positions.length, 2, 'je Flottenyacht ein Datensatz');
  const pa = r.positions.find(p => p.mmsi === a.mmsi);
  assert.equal(pa.ts, '2026-11-07T10:00:00.000Z', 'jüngster Datensatz je IMO');
  assert.equal(pa.nav_status, 1);
  assert.equal(pa.extra.ais_mmsi, '999000001');
  assert.equal(pa.static.imo, String(a.imo));
  const pb = r.positions.find(p => p.mmsi === b.mmsi);
  assert.equal(pb.nav_status, 0);
  assert.equal(pb.sog, 12.4);
});

test('Navigationsstatus-Text → AIS-Code', () => {
  assert.equal(dl.navCode('Moored'), 5);
  assert.equal(dl.navCode('At anchor'), 1);
  assert.equal(dl.navCode('Under way sailing'), 8);
  assert.equal(dl.navCode('Under way using engine'), 0);
  assert.equal(dl.navCode('Not defined'), null);
  assert.equal(dl.navCode(5), 5);
  assert.equal(dl.navCode(null), null);
});

test('Bulk: Teilabrufe ≤ 100, 402 bricht ab, 404 kostenlos, fehlender Header → Schätzung', async () => {
  const ids = YACHTS.map(y => y.mmsi);
  assert.ok(ids.length > 100);
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n === 1) return respond(200, { data: { total: 1, vessels: [{ mmsi: YACHTS[0].mmsi, imo: YACHTS[0].imo,
      lat: 1, lon: 1, speed: 0, last_position_UTC: '2026-11-07T00:00:00Z' }] }, meta: { success: true } });   // ohne Header
    return respond(402, { meta: { success: false, message: 'Payment Required' } }, 0);
  };
  const r = await dl.fetchLive(ids);
  assert.equal(n, 2);
  assert.equal(r.calls[0].estimated, true);
  assert.equal(r.calls[0].charged, 1);
  assert.equal(r.calls[1].status, 402);
  assert.equal(r.positions.length, 1, 'Teilergebnis bleibt');

  global.fetch = async () => respond(404, { meta: { success: false } }, 0);
  const e = await dl.fetchLive([YACHTS[0].mmsi]);
  assert.equal(e.charged, 0);
  assert.equal(e.positions.length, 0);

  global.fetch = async () => respond(402, { meta: { success: false } }, 0);
  await assert.rejects(dl.fetchLive([YACHTS[0].mmsi]), /402/);
});

test('Historie: from/to als Datum, kein days, aufsteigend sortiert, nur angefragte Tage', async () => {
  const y = withImo[0];
  let url;
  global.fetch = async (u) => {
    url = new URL(u);
    return respond(200, { data: { imo: y.imo, positions: [
      { lat: 43.2, lon: 7.2, speed: 0, course: 0, heading: 0, last_position_UTC: '2026-11-07T00:10:00Z' },   // außerhalb
      { lat: 43.2, lon: 7.2, speed: 0.1, course: 0, heading: 0, last_position_UTC: '2026-11-06T23:00:00Z' },
      { lat: 43.1, lon: 7.1, speed: 11, course: 80, heading: 81, last_position_UTC: '2026-11-06T08:00:00Z' },
    ] }, meta: { success: true } }, 4);
  };
  const r = await dl.fetchHistory(y.mmsi, '2026-11-06T00:00:00Z', '2026-11-06T23:59:59Z');
  assert.equal(url.pathname, '/api/v0/vessel_history');
  assert.equal(url.searchParams.get('imo'), String(y.imo));
  assert.equal(url.searchParams.get('from'), '2026-11-06');
  assert.equal(url.searchParams.get('to'), '2026-11-06');
  assert.equal(url.searchParams.get('days'), null);
  assert.equal(r.charged, 4);
  assert.deepEqual(r.positions.map(p => p.ts), ['2026-11-06T08:00:00.000Z', '2026-11-06T23:00:00.000Z']);
  assert.equal(r.positions[0].mmsi, y.mmsi);
  assert.equal(r.positions[0].nav_status, null);
  assert.equal(r.calls[0].outside_range, 1);
  assert.equal(r.calls[0].dates_returned, 2);

  process.env.DL_HISTORY_TO_EXCLUSIVE = 'true';
  await dl.fetchHistory(y.mmsi, '2026-11-06T00:00:00Z', '2026-11-06T23:59:59Z');
  assert.equal(url.searchParams.get('to'), '2026-11-07');
  delete process.env.DL_HISTORY_TO_EXCLUSIVE;

  // ohne Header: 2 Credits je zurückgeliefertem Datum mit Daten (belegt: Doku)
  global.fetch = async () => respond(200, { data: { positions: [
    { lat: 1, lon: 1, speed: 0, last_position_UTC: '2026-10-01T05:00:00Z' },
    { lat: 1, lon: 1, speed: 0, last_position_UTC: '2026-10-03T05:00:00Z' }] }, meta: { success: true } });
  const est = await dl.fetchHistory(y.mmsi, '2026-10-01T00:00:00Z', '2026-10-30T23:59:59Z');
  assert.equal(est.charged, 4);
  assert.equal(est.calls[0].estimated, true);
  await assert.rejects(dl.fetchHistory(y.mmsi, '2026-10-01T00:00:00Z', '2026-11-01T23:59:59Z'), /30/);
});

test('Abfrage über MMSI wählbar (DL_ID_TYPE=mmsi)', async () => {
  process.env.DL_ID_TYPE = 'mmsi';
  let url;
  global.fetch = async (u) => { url = new URL(u); return respond(200, { data: { positions: [] }, meta: { success: true } }, 0); };
  await dl.fetchHistory(YACHTS[0].mmsi, '2026-11-06T00:00:00Z', '2026-11-06T23:59:59Z');
  assert.equal(url.searchParams.get('mmsi'), YACHTS[0].mmsi);
  assert.equal(url.searchParams.get('imo'), null);
  delete process.env.DL_ID_TYPE;
});

test('Identitätsabgleich über IMO liefert alle Datensätze', async () => {
  const y = withImo[0];
  global.fetch = async () => respond(200, { data: { total: 2, vessels: [
    { mmsi: '1', imo: y.imo, name: 'X', last_position_UTC: '2026-11-01T00:00:00Z' },
    { mmsi: '2', imo: y.imo, name: 'Y', last_position_UTC: '2025-01-01T00:00:00Z' }] }, meta: { success: true } }, 2);
  const r = await dl.fetchByImo([y.imo]);
  assert.equal(r.records.length, 2);
  assert.equal(r.charged, 2);
  assert.equal(r.records[0].received, '2026-11-01T00:00:00.000Z');
});

test('Planung mit Datalastic Starter: 30 Tage je Abfrage, Variante B im Budget', () => {
  const cfg = loadConfig({ AIS_PROVIDER: 'datalastic', CREDIT_MONTH_BUDGET: '20000', CREDIT_DAILY_CAP: '800',
    POLL_HOURS_UTC: '9,21' });
  assert.equal(daysPerHistoryCall(cfg, dl), 30);
  const s = computeSchedule(cfg, YACHTS.length, dl.COSTS);
  assert.equal(s.polls_per_day, 2);
  assert.equal(s.breakdown.extended_extra, 0, 'kein Aufpreis für extended');
  assert.equal(s.breakdown.history, YACHTS.length * 31 * 2);
  assert.equal(s.over_budget, false);
  assert.ok(s.share_pct < 70, `Anteil ${s.share_pct} %`);
  // Mit der alten Mindesttaktung (4×/Tag automatisch) wäre Starter überbucht
  const auto = computeSchedule(loadConfig({ AIS_PROVIDER: 'datalastic', CREDIT_MONTH_BUDGET: '20000' }), YACHTS.length, dl.COSTS);
  assert.equal(auto.over_budget, true);
});
