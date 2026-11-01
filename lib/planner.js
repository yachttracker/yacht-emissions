// ── Abruflogik: Live-Karte, Fahrterkennung, priorisierter Historienkauf ─────
//
// Prinzip (Simulation 2026-10-17, siehe 07_abruflogik.md):
//   1. Live-Sammelabruf zu festen UTC-Stunden (Karte + Fahrterkennung).
//   2. Jede Live-Meldung wird gegen die vorige Position geprüft:
//      SOG > vMoveKn  oder  Verschiebung > dispThreshSm  →  Tag(e) "bewegt".
//   3. Einmal täglich Historie (Basic 1-min-, Trial 15-min-Raster) für abgeschlossene Tage kaufen, in
//      Prioritäten:  P1 bewegt  >  P2 unsicher (zu wenig Live-Treffer)  >  P3 Liegetag.
//      P1/P2 dürfen das gesamte freie Monatsbudget nutzen, P3 nur den fairen
//      Tagesanteil (Restbudget / Resttage). Am Monatsende fließt so das Restbudget
//      in Liegetage, statt zu verfallen, und liefert nebenbei eine Stichprobe zur
//      Trefferquote der Erkennung (history_moved vs. moved).
//   4. Live-Credits für den Rest des Monats werden vorab reserviert.
//   5. Harte Grenzen: CREDIT_DAILY_CAP und CREDIT_MONTH_BUDGET; vor jedem Abruf geprüft.
//   6. Restbudget-Rückwärtsabruf (HISTORY_BACKFILL_DAYS > 0): In den letzten
//      HISTORY_BACKFILL_TAIL_DAYS Tagen der Abrechnungsperiode fließt das Budget, das sonst
//      verfiele (Credits verfallen monatlich, belegt: MST-FAQ), in ältere Tage – standardmäßig
//      älteste zuerst (HISTORY_BACKFILL_ORDER=oldest, Paul 2026-11-01; 'newest' = jüngste zuerst),
//      bis HISTORY_BACKFILL_DAYS zurück (max. 725) bzw. ab HISTORY_BACKFILL_FROM. Eigener Typ 'history_backfill' im
//      credit_log; zählt zum Monat, nicht zum Tageslimit (sonst blockierte er die Karte).

const { YACHTS, byMmsi } = require('../fleet');
const { calcHourlyEmissions } = require('../emissions');
const credits = require('./credits');
const { computeSchedule, daysPerHistoryCall } = require('./schedule');
// Pausierte Yachten (data/tracking_state.csv) bekommen weder Live- noch Historienabrufe;
// das Lebenszeichen liefert der wöchentliche IMO-Abgleich (lib/identity.js, lib/tracking.js).
const tracking = require('./tracking');

const DAY_MS = 86400000;
const BACKFILL_MAX_DAYS = 725;   // 2 Jahre (MST) minus 5 Tage Sicherheitsrand (Annahme)
// Tage mit diesem Status werden nicht erneut gekauft. 'invalid' = bezahlt, aber keine gültigen
// Koordinaten (z. B. Trial-Maskierung, Prüfbericht W3); 'store_failed' wird erneut versucht.
const DONE_STATES = ['done', 'empty', 'invalid'];
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
    // Kontext für v3: Hafeninfo (extended) für Phase Hafen/Landstrom, AIS-Tiefgang für die Admiralitätsformel
    const em = calcHourlyEmissions(y, p.sog ?? 0, p.nav_status, {
      atPort: p.extra?.current_port ? true : undefined,
      draught: p.static?.draught ?? undefined,
    });
    const r = await pool.query(`
      INSERT INTO positions
        (mmsi, name, owner, flag, length_m, latitude, longitude, speed_knots, heading, cog, nav_status,
         co2_kg_h, nox_kg_h, sox_kg_h, fuel_kg_h, timestamp,
         me_load, mcr_kw, mcr_estimated, calc_version, source, dataset, observed, current_port,
         phase, p_main_kw, p_hotel_kw, fuel_main_kg_h, fuel_hotel_kg_h, co2_grid_kg_h)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,true,$23,
              $24,$25,$26,$27,$28,$29)
      ON CONFLICT (dataset, mmsi, timestamp, source) DO NOTHING`,
    [y.mmsi, y.name, y.owner, y.flag, y.length, p.lat, p.lon, p.sog ?? 0,
     p.heading === 511 ? null : p.heading, p.cog,
     p.nav_status === null || p.nav_status === undefined ? null : String(p.nav_status),
     em.co2_kg_h, em.nox_kg_h, em.sox_kg_h, em.fuel_kg_h, p.ts,
     em.me_load, em.mcr_kw, em.mcr_estimated, em.calc_version, source, dataset,
     p.extra?.current_port ?? null,
     em.phase, em.p_main_kw, em.p_hotel_kw, em.fuel_main_kg_h, em.fuel_hotel_kg_h, em.co2_grid_kg_h]);
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

// Verlustfreie Verdichtung: Im Liegen ist die Emissionsrate konstant, also ändert ein
// weggelassener Zwischenpunkt das Integral nicht, solange der Abstand der behaltenen
// Punkte unter der Lückengrenze (1 h) bleibt. In Fahrt bleibt jeder Punkt erhalten.
function compressStill(points, cfg) {
  if (!cfg.compressStill || points.length < 3) return points;
  const pts = [...points].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], last = out[out.length - 1], next = pts[i + 1];
    const moving = (p.sog ?? 0) > cfg.vMoveKn || (last.sog ?? 0) > cfg.vMoveKn || (next && (next.sog ?? 0) > cfg.vMoveKn);
    const dayChange = p.ts.slice(0, 10) !== last.ts.slice(0, 10);
    const tooLong = Date.parse(p.ts) - Date.parse(last.ts) >= cfg.compressMaxMin * 60000;
    const shifted = haversineSm(last, p) > cfg.compressMoveSm;
    if (moving || dayChange || tooLong || shifted || !next) out.push(p);
  }
  return out;
}

async function upsertStatic(pool, dataset, provider, mmsi, st) {
  await pool.query(`
    INSERT INTO vessel_static (dataset, mmsi, provider, imo, callsign, vessel_type, ais_type, flag, gt, dwt, built,
                               draught, length_m, beam_m, raw, fetched_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    ON CONFLICT (dataset, mmsi, provider) DO UPDATE SET
      imo = EXCLUDED.imo, callsign = EXCLUDED.callsign, vessel_type = EXCLUDED.vessel_type,
      ais_type = EXCLUDED.ais_type, flag = EXCLUDED.flag, gt = EXCLUDED.gt, dwt = EXCLUDED.dwt,
      built = EXCLUDED.built, draught = EXCLUDED.draught, length_m = EXCLUDED.length_m,
      beam_m = EXCLUDED.beam_m, raw = EXCLUDED.raw, fetched_at = NOW()`,
  [dataset, mmsi, provider, st.imo, st.callsign, st.vessel_type, st.ais_type, st.flag, st.gt, st.dwt,
   st.built, st.draught, st.length_m, st.beam_m, JSON.stringify(st.raw || {})]);
}

// ── 1. Live-Abruf ────────────────────────────────────────────────────────────
async function pollLive(pool, provider, cfg, { now = new Date(), extended = false } = {}) {
  const pz = await tracking.paused(pool, cfg.dataset);
  const mmsis = YACHTS.filter(y => !pz.has(y.mmsi)).map(y => y.mmsi);
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
    await logLiveCalls(pool, provider, cfg, kind, unit, e.calls || [{ ids: mmsis.length, charged: e.charged || 0,
      status: e.status, error: e.message }]);
    throw e;
  }
  // Ein credit_log-Eintrag je Teilabruf (≤ 100 IDs), damit Teilerfolge und Abbuchungen sichtbar bleiben
  await logLiveCalls(pool, provider, cfg, kind, unit, res.calls);
  const failed = res.calls.filter(c => c.error);
  if (failed.length) console.warn(`[ABRUF] Live: ${failed.length} von ${res.calls.length} Teilabrufen gescheitert, Teilergebnis gespeichert`);

  const today = dayStr(now);
  const seen = new Set();
  for (const p of res.positions) {
    if (!byMmsi.has(p.mmsi)) continue;
    seen.add(p.mmsi);
    const fresh = valid(p, cfg) && (now - Date.parse(p.ts)) <= cfg.staleHours * 3600000;
    await upsertDay(pool, cfg.dataset, p.mmsi, today, { live_polls: 1, live_hits: fresh ? 1 : 0,
      ...(p.extra ? { ext: JSON.stringify(p.extra) } : {}) });
    if (p.static) await upsertStatic(pool, cfg.dataset, provider.name, p.mmsi, p.static);
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

async function logLiveCalls(pool, provider, cfg, kind, unit, calls) {
  for (const c of calls) {
    const exp = c.ids * unit;
    const notes = [];
    if (c.error) notes.push(c.error.slice(0, 250));
    if (c.estimated) notes.push('X-Credit-Charged fehlt, aus Antwort geschätzt');
    if (c.error && c.status === null) notes.push('Abbuchung unbekannt');
    if (!c.error && c.charged > exp) notes.push('mehr berechnet als erwartet');
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind, ids: c.ids,
      credits: c.charged || 0, expected: exp, http_status: c.status ?? null, note: notes.join('; ') || null });
  }
}

// ── 2. Historien-Plan ────────────────────────────────────────────────────────
// Liefert die Kandidaten (Yacht, Tag) mit Priorität, ohne etwas abzurufen.
async function buildHistoryCandidates(pool, cfg, { now = new Date(), lookbackDays = cfg.lookbackDays,
  costs = { live_simple: 1, live_extended: 3, history_day: 5 } } = {}) {
  const today = Date.parse(dayStr(now));
  const days = [];
  for (let i = 1; i <= lookbackDays; i++) days.push(dayStr(today - i * DAY_MS));   // nur abgeschlossene Tage
  const r = await pool.query(`
    SELECT mmsi, day::text AS day, live_polls, live_hits, moved, history_status
      FROM vessel_days WHERE dataset = $1 AND day = ANY($2::date[])`, [cfg.dataset, days]);
  const known = new Map(r.rows.map(row => [`${row.mmsi}|${row.day}`, row]));
  const polls = computeSchedule(cfg, YACHTS.length, costs).polls_per_day;
  const pz = await tracking.paused(pool, cfg.dataset);
  const cands = [];
  for (const y of YACHTS) for (const d of days) {
    if (pz.has(y.mmsi)) continue;                    // pausiert: keine Historie
    const row = known.get(`${y.mmsi}|${d}`);
    if (row && DONE_STATES.includes(row.history_status)) continue;
    let prio, why;
    if (row?.moved) { prio = 1; why = 'bewegt'; }
    else if (!row || row.live_hits < Math.ceil(polls / 2)) { prio = 2; why = row ? 'wenig Live-Treffer' : 'keine Live-Daten'; }
    else { prio = 3; why = 'Liegetag'; }
    cands.push({ mmsi: y.mmsi, name: y.name, day: d, prio, why });
  }
  // Nach automatischer Wiederaufnahme: Tage seit der ersten neuen Meldung nachkaufen (auch älter als lookback)
  const extra = (await tracking.resumeDays(pool, cfg.dataset, now))
    .filter(x => !days.includes(x.day) && !pz.has(x.mmsi));
  if (extra.length) {
    const rr = await pool.query(`SELECT mmsi, day::text AS day, history_status FROM vessel_days
                                  WHERE dataset = $1 AND day = ANY($2::date[])`, [cfg.dataset, [...new Set(extra.map(x => x.day))]]);
    const st = new Map(rr.rows.map(x => [`${x.mmsi}|${x.day}`, x.history_status]));
    for (const x of extra) {
      if (DONE_STATES.includes(st.get(`${x.mmsi}|${x.day}`))) continue;
      cands.push({ ...x, prio: 1, why: 'Wiederaufnahme nach Pause' });
    }
  }
  // innerhalb gleicher Priorität: jüngste Tage zuerst
  cands.sort((a, b) => a.prio - b.prio || (a.day < b.day ? 1 : -1));
  return cands;
}

// Budget für Historie: Monatsrest minus Reserve für Live-Abrufe bis Monatsende.
function historyBudget(st, cfg, costs, fleetSize) {
  const sch = computeSchedule(cfg, fleetSize, costs);
  const livePerDay = sch.polls_per_day * fleetSize * costs.live_simple
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
  const cands = await buildHistoryCandidates(pool, cfg, { now, lookbackDays: opts.lookbackDays, costs: provider.COSTS });
  const b = historyBudget(st, cfg, provider.COSTS, YACHTS.length);
  const cost = provider.COSTS.history_day;
  // Backfill (einmalig, manuell) darf das freie Budget ohne Tagesanteil nutzen
  const p3limit = opts.backfill ? b.p12 : (cfg.fillStillDays ? b.p3 : 0);
  // Stichprobe: höchstens HISTORY_MAX_DAYS Yacht-Tage je Lauf (0 = unbegrenzt), z. B. im Trial
  const maxDays = cfg.historyMaxDays > 0 ? cfg.historyMaxDays : Infinity;
  let used = 0, used3 = 0;
  const selected = [], skipped = [];
  for (const c of cands) {
    const fits = selected.length < maxDays && used + cost <= b.p12 && (c.prio < 3 || used3 + cost <= p3limit);
    if (fits) { selected.push(c); used += cost; if (c.prio === 3) used3 += cost; } else skipped.push(c);
  }
  const bf = await planBackfill(pool, cfg, st, b, { now, used, cost, maxDays: maxDays - selected.length,
    regularLookback: opts.lookbackDays || cfg.lookbackDays, manual: !!opts.backfill });
  return { status: st, budget: b, expected_credits: used + bf.expected, selected, skipped,
           calls: groupCalls(selected, daysPerHistoryCall(cfg)),
           backfill: { budget: bf.budget, expected_credits: bf.expected, days: bf.selected.length,
                       from: bf.selected.map(x => x.day).sort()[0] ?? null,
                       to: bf.selected.map(x => x.day).sort().at(-1) ?? null },
           backfill_calls: groupCalls(bf.selected, daysPerHistoryCall(cfg)) };
}

// Restbudget-Rückwärtsabruf: nur in den letzten Tagen der Periode, nur im Regelbetrieb.
// Budget = freies Monatsbudget (nach Live-Reserve) minus heutiger Regelkauf minus Reserve für die
// Regel-Historie der restlichen Tage, verteilt auf die restlichen Tage der Periode.
async function planBackfill(pool, cfg, st, b, { now, used, cost, maxDays, regularLookback, manual }) {
  const none = { budget: 0, expected: 0, selected: [] };
  if (manual || cfg.trial || !(cfg.backfillDays > 0) || st.days_left > cfg.backfillTailDays || maxDays <= 0) return none;
  const histReserve = YACHTS.length * cost * Math.max(st.days_left - 1, 0);
  const budget = Math.max(Math.floor((b.free - used - histReserve) / st.days_left), 0);
  if (budget < cost) return none;
  const today = Date.parse(dayStr(now));
  const first = regularLookback + 1;
  // Fenster: MST-Historie reicht 2 Jahre zurück (belegt: Track-Doku); genaue Kante ungeklärt → 5 Tage Sicherheitsrand (Annahme).
  let last = Math.min(cfg.backfillDays, BACKFILL_MAX_DAYS);
  if (cfg.backfillFrom) {
    const fromIdx = Math.floor((today - Date.parse(cfg.backfillFrom)) / DAY_MS);
    last = Math.min(last, fromIdx);                       // nicht älter als die gewählte Untergrenze
  }
  if (last < first) return none;
  const r = await pool.query(`
    SELECT mmsi, day::text AS day FROM vessel_days
     WHERE dataset = $1 AND day BETWEEN $2::date AND $3::date AND history_status = ANY($4::text[])`,
  [cfg.dataset, dayStr(today - last * DAY_MS), dayStr(today - first * DAY_MS), DONE_STATES]);
  const have = new Set(r.rows.map(x => `${x.mmsi}|${x.day}`));
  const pz = await tracking.paused(pool, cfg.dataset);
  for (const m of pz.keys()) for (let i = first; i <= last; i++) have.add(`${m}|${dayStr(today - i * DAY_MS)}`);   // pausiert: kein Rückwärtsabruf
  const selected = [];
  let spent = 0;
  const oldestFirst = cfg.backfillOrder !== 'newest';
  // 'oldest': älteste Tage zuerst (fallen zuerst aus dem 2-Jahres-Fenster), die Reihe wächst vorwärts.
  // 'newest': jüngste zuerst, die Reihe wächst rückwärts.
  outer: for (let k = 0; k <= last - first; k++) {
    const i = oldestFirst ? last - k : first + k;
    const d = dayStr(today - i * DAY_MS);
    for (const y of YACHTS) {
      if (have.has(`${y.mmsi}|${d}`)) continue;
      if (spent + cost > budget || selected.length >= maxDays) break outer;
      selected.push({ mmsi: y.mmsi, name: y.name, day: d, prio: 4, why: 'Rückwärtsabruf Restbudget' });
      spent += cost;
    }
  }
  return { budget, expected: spent, selected };
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
  const result = { calls: 0, charged: 0, days_done: 0, days_empty: 0, days_invalid: 0, errors: [] };
  const jobs = [...plan.calls.map(c => ({ ...c, kind: 'history' })),
                ...(plan.backfill_calls || []).map(c => ({ ...c, kind: 'history_backfill' }))];
  let backfillSpent = 0;
  for (const call of jobs) {
    const expected = call.days.length * provider.COSTS.history_day;
    const st = await credits.status(pool, cfg, provider.name, opts.now || new Date());
    const ok = call.kind === 'history_backfill'
      ? expected <= st.month_left && backfillSpent + expected <= plan.backfill.budget
      : credits.canSpend(st, expected);
    if (!ok) { result.errors.push(`Limit erreicht vor ${call.mmsi} (${call.kind})`); break; }
    const from = `${call.days[0]}T00:00:00Z`;
    const to = new Date(Date.parse(call.days[call.days.length - 1]) + DAY_MS - 1000).toISOString().replace('.000', '');
    let res;
    try {
      res = await provider.fetchHistory(call.mmsi, from, to, { timegroup: cfg.timegroupMin });
    } catch (e) {
      await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: call.kind, mmsi: call.mmsi,
        day_from: call.days[0], day_to: call.days.at(-1), credits: e.charged || 0, expected,
        http_status: e.status, note: e.message.slice(0, 300) });
      backfillSpent += call.kind === 'history_backfill' ? (e.charged || 0) : 0;
      for (const d of call.days) await upsertDay(pool, cfg.dataset, call.mmsi, d, { history_status: 'failed' });
      result.errors.push(`${call.mmsi}: ${e.message}`);
      if (e.status === 402 || e.status === 401) break;           // keine Credits / Schlüssel: abbrechen
      continue;
    }
    result.calls++; result.charged += res.charged;
    if (call.kind === 'history_backfill') { result.backfill_days = (result.backfill_days || 0) + call.days.length; backfillSpent += res.charged; }
    const notes = [];
    if (res.calls[0]?.estimated) notes.push('X-Credit-Charged fehlt, aus Antwort geschätzt');
    if (res.charged > expected) notes.push('mehr berechnet als erwartet');
    await credits.log(pool, { provider: provider.name, dataset: cfg.dataset, kind: call.kind, mmsi: call.mmsi,
      day_from: call.days[0], day_to: call.days.at(-1), ids: 1, credits: res.charged, expected,
      http_status: res.calls[0]?.status, note: notes.join('; ') || null });

    const pts = res.positions.filter(p => valid(p, cfg));
    if (res.positions.length >= cfg.recordLimit) {
      result.errors.push(`${call.mmsi} ${call.days[0]}: Datensatzlimit erreicht, Daten evtl. abgeschnitten`);
    }
    const kept = compressStill(pts, cfg);
    try {
      await insertPositions(pool, kept, 'history', cfg.dataset);
    } catch (e) {
      // z. B. volle Platte (Prüfbericht K3): Tage markieren und den Lauf beenden, statt weiter zu kaufen
      console.error(`[ABRUF] Historie ${call.mmsi}: Speichern fehlgeschlagen (${e.message}) – Lauf abgebrochen`);
      for (const d of call.days) {
        await upsertDay(pool, cfg.dataset, call.mmsi, d, { history_status: 'store_failed' }).catch(() => {});
      }
      result.errors.push(`${call.mmsi}: Speichern fehlgeschlagen, Lauf abgebrochen`);
      break;
    }
    result.points_raw = (result.points_raw || 0) + pts.length;
    result.points_kept = (result.points_kept || 0) + kept.length;
    const chargedPerDay = call.days.length ? res.charged / call.days.length : 0;
    for (const d of call.days) {
      const dp = pts.filter(p => p.ts.startsWith(d));
      const rawDay = res.positions.filter(p => (p.ts || '').startsWith(d)).length;
      const maxSog = dp.reduce((m, p) => Math.max(m, p.sog ?? 0), 0);
      // 'invalid': Punkte geliefert und bezahlt, aber keine gültigen Koordinaten (Trial-Maskierung?)
      const status = dp.length ? 'done' : (rawDay ? 'invalid' : 'empty');
      await upsertDay(pool, cfg.dataset, call.mmsi, d, {
        history_status: status,
        history_points: dp.length,
        history_credits: Math.round(chargedPerDay),
        history_max_sog: dp.length ? maxSog : null,
        history_moved: dp.length ? maxSog > cfg.vMoveKn : null,
        history_at: new Date().toISOString(),
      });
      if (status === 'done') result.days_done++; else if (status === 'invalid') result.days_invalid++; else result.days_empty++;
    }
  }
  return { ...result, planned: plan.selected.length };
}

module.exports = { compressStill, pollLive, planHistory, planBackfill, runHistory, DONE_STATES, buildHistoryCandidates, historyBudget, groupCalls,
                   haversineSm, insertPositions };
