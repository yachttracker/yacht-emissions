// ── Konfiguration der Abruflogik (alles über Railway-Variablen steuerbar) ───
// Status je Wert: belegt / Annahme / ungeklärt (siehe 07_abruflogik.md)
const list = (v, d) => (v ? String(v).split(',').map(s => Number(s.trim())).filter(Number.isFinite) : d);
const bool = (v, d) => (v === undefined ? d : v === 'true');

function loadConfig(env = process.env) {
  return {
    provider: (env.AIS_PROVIDER || 'none').toLowerCase(),
    dataset: env.AIS_DATASET || (env.AIS_PROVIDER === 'mock' ? 'mock' : 'prod'),
    dryRun: bool(env.FETCH_DRY_RUN, false),

    // Budget (Pflicht bei echtem Anbieter; ohne Werte wird nichts abgerufen)
    monthBudget: Number(env.CREDIT_MONTH_BUDGET) || 0,
    dailyCap: Number(env.CREDIT_DAILY_CAP) || 0,

    // Karte: Sammelabrufe zu festen UTC-Stunden. Annahme: 4×/Tag (Simulation: 94 % Fahrstunden
    // schon ohne Auffüllung erkannt; Karte max. 6 h alt).
    pollHoursUtc: list(env.POLL_HOURS_UTC, [4, 10, 16, 22]),
    liveExtended: bool(env.LIVE_EXTENDED, false),     // extended (3 Credits) – Felder ungeklärt
    extendedHourUtc: Number(env.EXTENDED_HOUR_UTC ?? 22),

    // Historie: Abruf des Vortags um HISTORY_HOUR_UTC, 5-min-Raster (Recherche 17.10.)
    historyHourUtc: Number(env.HISTORY_HOUR_UTC ?? 3),
    timegroupMin: Number(env.HISTORY_TIMEGROUP_MIN) || 5,
    lookbackDays: Number(env.HISTORY_LOOKBACK_DAYS) || 3,      // offene Tage nachholen
    maxDaysPerCall: Number(env.HISTORY_MAX_DAYS_PER_CALL) || 7, // 7 × 288 = 2016 < 3000 Datensätze (belegt: Limit 3000)
    fillStillDays: bool(env.HISTORY_FILL_STILL, true),         // Restbudget für Liegetage

    // Fahrterkennung (Annahmen)
    vMoveKn: Number(env.DETECT_V_KN) || 2,           // wie V_IDLE_KN in emissions.js (EPA 2025)
    dispThreshSm: Number(env.DETECT_DISP_SM) || 0.3, // Schwojkreis großer Yachten ~0,1 sm (Annahme)
    staleHours: Number(env.LIVE_STALE_HOURS) || 6,   // ältere Live-Meldung = kein Treffer

    // Plausibilität
    maxSogKn: Number(env.MAX_PLAUSIBLE_SOG_KN) || 45,
  };
}

module.exports = { loadConfig };
