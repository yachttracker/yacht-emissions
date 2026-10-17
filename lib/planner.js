// ── Abruflogik: Live-Karte, Fahrterkennung, priorisierter Historienkauf ─────
//
// Prinzip (Simulation 2026-10-17, siehe 07_abruflogik.md):
//   1. Live-Sammelabruf zu festen UTC-Stunden (Karte + Fahrterkennung).
//   2. Jede Live-Meldung wird gegen die vorige Position geprüft:
//      SOG > vMoveKn  oder  Verschiebung > dispThreshSm  →  Tag(e) "bewegt".
//   3. Einmal täglich Historie (5-min-Raster) für abgeschlossene Tage kaufen, in
//      Prioritäten:  P1 bewegt  >  P2 unsicher (zu wenig Live-Treffer)  >  P3 Liegetag.
//      P1/P2 dürfen das gesamte freie Monatsbudget nutzen, P3 nur den fairen
//      Tagesanteil (Restbudget / Resttage). Am Monatsende fließt so das Restbudget
//      in Liegetage, statt zu verfallen, und liefert nebenbei eine Stichprobe zur
//      Trefferquote der Erkennung (history_moved vs. moved).
//   4. Live-Credits für den Rest des Monats werden vorab reserviert.
//   5. Harte Grenzen: CREDIT_DAILY_CAP und CREDIT_MONTH_BUDGET; vor jedem Abruf geprüft.

const { YACHTS, byMmsi } = require('../fleet');
const { calcHourlyEmissions } = require('../emissions');
const credits = require('./credits');

const DAY_MS = 86400000;
const dayStr = (d) => new Date(d).toISOString().slice(0, 10);

function haversineSm(a, b) {
  const R = 3440.065; // Erdradius in sm
  const toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function valid(p, cfg) {
  if (!p.ts || p.lat === null || p.lon === null) return false;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || (p.lat === 0 && p.lon === 0)) return false;
  if (p.sog !== null && (p.sog < 0 || p.sog > cfg.maxSogKn)) return false;
  return true;
}

// ── Speichern ────────────────────────────────────────────────────────────────
async function insertPositions(pool, positions, source, dataset) {
  let n = 0;
  for (const p of positions) {
    const y = byMmsi.get(p.mmsi);
    if (!y) continue;
    const em = calcHourlyEmissions(y, p.sog ?? 0, p.nav_status);
    const r = await pool.query(`
      INSERT INTO positions
        (mmsi, name, owner, flag, length_m, latitude, longitude, speed_knots, heading, cog, nav_status,
         co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp,
         me_load, mcr_kw, mcr_estimated, calc_version, source, dataset, observed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,true)
      ON CONFLICT (dataset, mmsi, timestamp, source) DO NOTHING`,
    [y.mmsi, y.name, y.owner, y.flag, y.length, p.lat, p.lon, p.sog ?? 0,
     p.heading === 511 ? null : p.heading, p.cog,
     p.nav_status === null || p.nav_status === undefined ? null : String(p.nav_status),
     em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h, p.ts,
     em.me_load, em.mcr_kw, em.mcr_estimated, em.calc_version, source, dataset]);
    n += r.rowCount;
  }
  return n;
}

async function upsertDay(pool, dataset, mmsi, day, patch) {
  await pool.query(`
    INSERT INTO vessel_days (dataset, mmsi, day) VALUES ($1,$2,$3)
    ON CONFLICT (dataset, mmsi, day) DO NOTHING`, [dataset, mmsi, day]);
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => {
    if (k === 'live_polls' || k === 'live_hits') return `${k} = ${k} + $${i + 4}`;
    if (k === 'moved') return `moved = moved OR $${i + 4}`;
    if (k === 'moved_reason') return `moved_reason = COALESCE(moved_reason || ',', '') || $${i + 4}`;
    return `${k} = $${i + 4}`;
  });
  await pool.query(`UPDATE vessel_days SET ${sets.join(', ')}, updated_at = NOW()
                     WHERE dataset = $1 AND mmsi = $2 AND day = $3`,
  [dataset, mmsi, day, ...keys.map(k => patch[k])]);
}

async function lastPosition(pool, dataset, mmsi, beforeTs) {
  const r = await pool.query(`
    SELECT latitude AS lat, longitude AS lon, timestamp AS ts FROM positions
     WHERE dataset = $1 AND mmsi = $2 AND timestamp < $3
     ORDER BY timestamp DESC LIMIT 1`, [dataset, mmsi, beforeTs]);
  return r.rows[0] || null;
}

// ── 1. Live-Abruf ────────────────────────────────────────────────────────────
async function pollLive(pool, provider, cfg, { now = new Date(), extended = false } = {}) {
  const mmsis = YACHTS.map(y => y.mmsi);
  const unit = extended ? provider.COSTS.live_extended : provider.COSTS.live_simple;
  const expected = mmsis.length * unit;
  const st = await credits.status(pool, cfg, provider.name, now);
  const kind = extended ? 'live_ext' : 'live';

  if (cfg.dryRun) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind, ids: mmsis.length,
      credits: 0, expected, dry_run: true, note: 'dry-run' });
    return { dry_run: true, expected };
  }
  if (!credits.canSpend(st, expected)) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind, ids: mmsis.length,
      credits: 0, expected, note: 'übersprungen: Budget/Tageslimit' });
    return { skipped: true, expected, status: st };
  }

  let res;
  try {
    res = await provider.fetchLive(mmsis, { extended, now: now.getTime() });
  } catch (e) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind, ids: mmsis.length,
      credits: e.charged || 0, expected, http_status: e.status, note: e.message.slice(0, 300) });
    throw e;
  }
  await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind, ids: mmsis.length,
    credits: res.charged, expected, http_status: res.calls[0]?.status });

  const today = dayStr(now);
  const seen = new Set();
  for (const p of res.positions) {
    if (!byMmsi.has(p.mmsi)) continue;
    seen.add(p.mmsi);
    const fresh = valid(p, cfg) && (now - Date.parse(p.ts)) <= cfg.staleHours * 3600000;
    await upsertDay(pool, cfg.dataset, p.mmsi, today, { live_polls: 1, live_hits: fresh ? 1 : 0,
      ...(p.extra ? { ext: JSON.stringify(p.extra) } : {}) });
    if (!valid(p, cfg)) continue;

    // Erkennung
    const reasons = [];
    if ((p.sog ?? 0) > cfg.vMoveKn) reasons.push('sog');
    const prev = await lastPosition(pool, cfg.dataset, p.mmsi, p.ts);
    let fromDay = dayStr(p.ts);
    if (prev && haversineSm(prev, p) > cfg.dispThreshSm) { reasons.push('disp'); fromDay = dayStr(prev.ts); }
    if (p.extra && ((p.extra.max_sog ?? 0) > cfg.vMoveKn || (p.extra.distance_covered ?? 0) > 1)) reasons.push('ext');
    if (reasons.length) {
      for (let t = Date.parse(fromDay); t <= Date.parse(dayStr(p.ts)); t += DAY_MS) {
        await upsertDay(pool, cfg.dataset, p.mmsi, dayStr(t), { moved: true, moved_reason: reasons.join('+') });
      }
    }
    await insertPositions(pool, [p], 'live', cfg.dataset);
  }
  for (const m of mmsis) if (!seen.has(m)) await upsertDay(pool, cfg.dataset, m, today, { live_polls: 1 });
  return { charged: res.charged, positions: res.positions.length };
}

// ── 2. Historien-Plan ────────────────────────────────────────────────────────
// Liefert die Kandidaten (Yacht, Tag) mit Priorität, ohne etwas abzurufen.
async function buildHistoryCandidates(pool, cfg, { now = new Date(), lookbackDays = cfg.lookbackDays } = {}) {
  const today = Date.parse(dayStr(now));
  const days = [];
  for (let i = 1; i <= lookbackDays; i++) days.push(dayStr(today - i * DAY_MS));   // nur abgeschlossene Tage
  const r = await pool.query(`
    SELECT mmsi, day::text AS day, live_polls, live_hits, moved, history_status
      FROM vessel_days WHERE dataset = $1 AND day = ANY($2::date[])`, [cfg.dataset, days]);
  const known = new Map(r.rows.map(row => [`${row.mmsi}|${row.day}`, row]));
  const polls = cfg.pollHoursUtc.length;
  const cands = [];
  for (const y of YACHTS) for (const d of days) {
    const row = known.get(`${y.mmsi}|${d}`);
    if (row && (row.history_status === 'done' || row.history_status === 'empty')) continue;
    let prio, why;
    if (row?.moved) { prio = 1; why = 'bewegt'; }
    else if (!row || row.live_hits < Math.ceil(polls / 2)) { prio = 2; why = row ? 'wenig Live-Treffer' : 'keine Live-Daten'; }
    else { prio = 3; why = 'Liegetag'; }
    cands.push({ mmsi: y.mmsi, name: y.name, day: d, prio, why });
  }
  // innerhalb gleicher Priorität: jüngste Tage zuerst
  cands.sort((a, b) => a.prio - b.prio || (a.day < b.day ? 1 : -1));
  return cands;
}

// Budget für Historie: Monatsrest minus Reserve für Live-Abrufe bis Monatsende.
function historyBudget(st, cfg, costs, fleetSize) {
  const livePerDay = cfg.pollHoursUtc.length * fleetSize * costs.live_simple
    + (cfg.liveExtended ? fleetSize * (costs.live_extended - costs.live_simple) : 0);
  const reserve = livePerDay * st.days_left;
  const free = Math.max(st.month_left - reserve, 0);
  const todayFree = Math.max(st.today_left - livePerDay, 0);   // Live-Abrufe des Tages nicht blockieren
  return {
    p12: Math.min(free, todayFree),                             // bewegt/unsicher
    p3: Math.min(Math.floor(free / st.days_left), todayFree),   // fairer Tagesanteil
    reserve, free,
  };
}

// Kandidaten zu Abrufen bündeln: aufeinanderfolgende Tage je Yacht in einem Aufruf.
function groupCalls(selected, maxDays) {
  const byY = new Map();
  for (const c of selected) { if (!byY.has(c.mmsi)) byY.set(c.mmsi, []); byY.get(c.mmsi).push(c.day); }
  const calls = [];
  for (const [mmsi, ds] of byY) {
    ds.sort();
    let run = [ds[0]];
    for (let i = 1; i <= ds.length; i++) {
      const consecutive = i < ds.length && Date.parse(ds[i]) - Date.parse(run[run.length - 1]) === DAY_MS;
      if (consecutive && run.length < maxDays) { run.push(ds[i]); continue; }
      calls.push({ mmsi, days: run });
      if (i < ds.length) run = [ds[i]];
    }
  }
  return calls;
}

async function planHistory(pool, provider, cfg, opts = {}) {
  const now = opts.now || new Date();
  const st = await credits.status(pool, cfg, provider.name, now);
  const cands = await buildHistoryCandidates(pool, cfg, { now, lookbackDays: opts.lookbackDays });
  const b = historyBudget(st, cfg, provider.COSTS, YACHTS.length);
  const cost = provider.COSTS.history_day;
  // Backfill (einmalig, manuell) darf das freie Budget ohne Tagesanteil nutzen
  const p3limit = opts.backfill ? b.p12 : (cfg.fillStillDays ? b.p3 : 0);
  let used = 0, used3 = 0;
  const selected = [], skipped = [];
  for (const c of cands) {
    const fits = used + cost <= b.p12 && (c.prio < 3 || used3 + cost <= p3limit);
    if (fits) { selected.push(c); used += cost; if (c.prio === 3) used3 += cost; } else skipped.push(c);
  }
  return { status: st, budget: b, expected_credits: used, selected, skipped,
           calls: groupCalls(selected, cfg.maxDaysPerCall) };
}

// ── 3. Historie abrufen und speichern ───────────────────────────────────────
async function runHistory(pool, provider, cfg, opts = {}) {
  const plan = await planHistory(pool, provider, cfg, opts);
  if (cfg.dryRun || opts.dryRun) {
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'history',
      credits: 0, expected: plan.expected_credits, dry_run: true,
      note: `dry-run: ${plan.selected.length} Tage in ${plan.calls.length} Aufrufen` });
    return { dry_run: true, ...plan };
  }
  const result = { calls: 0, charged: 0, days_done: 0, days_empty: 0, errors: [] };
  for (const call of plan.calls) {
    const expected = call.days.length * provider.COSTS.history_day;
    const st = await credits.status(pool, cfg, provider.name, opts.now || new Date());
    if (!credits.canSpend(st, expected)) { result.errors.push(`Limit erreicht vor ${call.mmsi}`); break; }
    const from = `${call.days[0]}T00:00:00Z`;
    const to = new Date(Date.parse(call.days[call.days.length - 1]) + DAY_MS - 1000).toISOString().replace('.000', '');
    let res;
    try {
      res = await provider.fetchHistory(call.mmsi, from, to, { timegroup: cfg.timegroupMin });
    } catch (e) {
      await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'history', mmsi: call.mmsi,
        day_from: call.days[0], day_to: call.days.at(-1), credits: e.charged || 0, expected,
        http_status: e.status, note: e.message.slice(0, 300) });
      for (const d of call.days) await upsertDay(pool, cfg.dataset, call.mmsi, d, { history_status: 'failed' });
      result.errors.push(`${call.mmsi}: ${e.message}`);
      if (e.status === 402 || e.status === 401) break;           // keine Credits / Schlüssel: abbrechen
      continue;
    }
    result.calls++; result.charged += res.charged;
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: 'history', mmsi: call.mmsi,
      day_from: call.days[0], day_to: call.days.at(-1), ids: 1, credits: res.charged, expected,
      http_status: res.calls[0]?.status,
      note: res.charged > expected ? 'mehr berechnet als erwartet' : null });

    const pts = res.positions.filter(p => valid(p, cfg));
    await insertPositions(pool, pts, 'history', cfg.dataset);
    for (const d of call.days) {
      const dp = pts.filter(p => p.ts.startsWith(d));
      const maxSog = dp.reduce((m, p) => Math.max(m, p.sog ?? 0), 0);
      await upsertDay(pool, cfg.dataset, call.mmsi, d, {
        history_status: dp.length ? 'done' : 'empty',
        history_points: dp.length,
        history_credits: dp.length ? provider.COSTS.history_day : 0,
        history_max_sog: dp.length ? maxSog : null,
        history_moved: dp.length ? maxSog > cfg.vMoveKn : null,
        history_at: new Date().toISOString(),
      });
      if (dp.length) result.days_done++; else result.days_empty++;
    }
  }
  return { ...result, planned: plan.selected.length };
}

module.exports = { pollLive, planHistory, runHistory, buildHistoryCandidates, historyBudget, groupCalls,
                   haversineSm, insertPositions };
