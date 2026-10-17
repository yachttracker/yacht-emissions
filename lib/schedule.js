// ── Taktung aus Budget und Flottengröße ─────────────────────────────────────
// Rangfolge: 1. Historie für jede Yacht und jeden Tag (Emissionen, höchste Priorität),
//            2. ein extended-Abruf pro Tag (Hafen/Anker, Stammdaten),
//            3. alles übrige Budget → Kartenabrufe (gleichmäßig über den Tag).
// Gerechnet wird mit 31 Tagen (ungünstigster Monat) und einem Puffer.
//
// Beispiel MST Basic 50.000, Puffer 10 %, 31 Tage:
//   100 Yachten: 15.500 Historie + 6.200 extended-Aufpreis → 7 Abrufe/Tag (≈ 3,4 h)
//    50 Yachten:  7.750 + 3.100                            → 22 Abrufe/Tag (≈ stündlich)
//    10 Yachten:                                           → 24 (Obergrenze)

function computeSchedule(cfg, fleetSize, costs) {
  const days = 31;
  const usable = cfg.monthBudget * (1 - cfg.bufferPct / 100);
  const hist = fleetSize * days * costs.history_day;
  const extExtra = cfg.liveExtended ? fleetSize * days * (costs.live_extended - costs.live_simple) : 0;
  const perPollMonth = fleetSize * days * costs.live_simple;

  let hours, polls;
  if (Array.isArray(cfg.pollHoursUtc) && cfg.pollHoursUtc.length) {
    hours = [...cfg.pollHoursUtc].sort((a, b) => a - b);
    polls = hours.length;
  } else {
    polls = perPollMonth > 0 ? Math.floor((usable - hist - extExtra) / perPollMonth) : 0;
    polls = Math.max(cfg.minPollsPerDay, Math.min(cfg.maxPollsPerDay, polls));
    // gleichmäßig verteilt, eine Stunde nach Mitternacht beginnend
    hours = [...new Set(Array.from({ length: polls }, (_, i) => Math.floor(1 + (i * 24) / polls) % 24))].sort((a, b) => a - b);
    polls = hours.length;
  }
  // extended auf den Abruf legen, der EXTENDED_HOUR_UTC am nächsten liegt
  const extHour = cfg.liveExtended
    ? hours.reduce((best, h) => (Math.abs(h - cfg.extendedHourUtc) < Math.abs(best - cfg.extendedHourUtc) ? h : best), hours[0])
    : null;
  const projected = hist + extExtra + polls * perPollMonth;
  return {
    fleet: fleetSize, polls_per_day: polls, hours_utc: hours, extended_hour_utc: extHour,
    interval_h: +(24 / polls).toFixed(1),
    projected_month_31d: projected,
    budget: cfg.monthBudget, usable,
    share_pct: cfg.monthBudget ? +(100 * projected / cfg.monthBudget).toFixed(1) : null,
    over_budget: cfg.monthBudget ? projected > cfg.monthBudget : null,
    breakdown: { history: hist, extended_extra: extExtra, live: polls * perPollMonth },
  };
}

// Tage je Historienaufruf so wählen, dass das Datensatzlimit nie erreicht wird
// (Annahme: höchstens 1 Datensatz je timegroup-Fenster; 5 % Sicherheitsabstand).
function daysPerHistoryCall(cfg) {
  const perDay = Math.ceil(1440 / cfg.timegroupMin);
  return Math.max(1, Math.floor((cfg.recordLimit * 0.95) / perDay));
}

module.exports = { computeSchedule, daysPerHistoryCall };
