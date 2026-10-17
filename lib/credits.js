// ── Credit-Zähler mit harter Tages- und Monatsgrenze ────────────────────────
// Monat = Kalendermonat UTC. Annahme: Abrechnungszeitraum des Anbieters ist der
// Kalendermonat (bei MyShipTracking "verfallen am Monatsende" laut Recherche; genaues
// Stichdatum ungeklärt).

async function spent(pool, provider, sinceSql) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(credits),0)::int AS c FROM credit_log
      WHERE provider = $1 AND NOT dry_run AND ts >= ${sinceSql}`, [provider]);
  return r.rows[0].c;
}

async function status(pool, cfg, provider, now = new Date()) {
  const month = await spent(pool, provider, `date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  const today = await spent(pool, provider, `date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - now.getUTCDate() + 1;            // inkl. heute
  return {
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

module.exports = { status, canSpend, log };
