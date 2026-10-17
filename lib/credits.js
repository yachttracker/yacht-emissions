// ── Credit-Zähler mit harter Tages- und Periodengrenze ──────────────────────
// Periode = Abrechnungsmonat ab CREDIT_PERIOD_START_DAY (Standard 1 = Kalendermonat, UTC).
// Belegt: MST setzt das Guthaben monatlich zurück, ungenutzte Credits verfallen (FAQ).
// Ungeklärt: ob der Stichtag der Kalendermonat oder das Vertragsdatum ist.

function periodBounds(now, startDay) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const clamp = (yy, mm) => Math.min(startDay, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
  let start = new Date(Date.UTC(y, m, clamp(y, m)));
  if (d < clamp(y, m)) start = new Date(Date.UTC(y, m - 1, clamp(y, m - 1)));
  const sy = start.getUTCFullYear(), sm = start.getUTCMonth();
  const end = new Date(Date.UTC(sy, sm + 1, clamp(sy, sm + 1)));
  return { start, end };
}

async function spentSince(pool, provider, since) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(credits),0)::int AS c FROM credit_log
      WHERE provider = $1 AND NOT dry_run AND ts >= $2`, [provider, since.toISOString()]);
  return r.rows[0].c;
}

async function status(pool, cfg, provider, now = new Date()) {
  const { start, end } = periodBounds(now, cfg.periodStartDay);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = await spentSince(pool, provider, start);
  const today = await spentSince(pool, provider, dayStart);
  const daysLeft = Math.max(1, Math.round((end - dayStart) / 86400000));   // inkl. heute
  return {
    period_start: start.toISOString().slice(0, 10), period_end: end.toISOString().slice(0, 10),
    month_spent: month, today_spent: today,
    month_budget: cfg.monthBudget, daily_cap: cfg.dailyCap,
    month_left: Math.max(cfg.monthBudget - month, 0),
    today_left: Math.max(cfg.dailyCap - today, 0),
    days_left: daysLeft,
  };
}

function canSpend(st, n) { return n <= st.month_left && n <= st.today_left; }

async function log(pool, entry) {
  await pool.query(`
    INSERT INTO credit_log (provider, dataset, kind, mmsi, day_from, day_to, ids, credits, expected, http_status, dry_run, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [entry.provider, entry.dataset, entry.kind, entry.mmsi || null, entry.day_from || null, entry.day_to || null,
   entry.ids || null, entry.credits || 0, entry.expected ?? null, entry.http_status ?? null, !!entry.dry_run, entry.note || null]);
}

module.exports = { status, canSpend, log, periodBounds };
