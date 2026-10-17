// ── Konfiguration der Abruflogik (alles über Railway-Variablen steuerbar) ───
// Status je Wert: belegt / Annahme / ungeklärt (siehe 07_abruflogik.md)
const list = (v, d) => (v ? String(v).split(',').map(s => Number(s.trim())).filter(Number.isFinite) : d);
const bool = (v, d) => (v === undefined ? d : v === 'true');

function loadConfig(env = process.env) {
  const trial = bool(env.PROVIDER_TRIAL, false);
  return {
    provider: (env.AIS_PROVIDER || 'none').toLowerCase(),
    dataset: env.AIS_DATASET || (env.AIS_PROVIDER === 'mock' ? 'mock' : trial ? 'trial' : 'prod'),
    trial,
    dryRun: bool(env.FETCH_DRY_RUN, false),

    // Budget (Pflicht bei echtem Anbieter; ohne Werte wird nichts abgerufen)
    // MST Basic: 50.000 Credits/Monat, Rücksetzung monatlich (belegt: Pricing, FAQ)
    monthBudget: Number(env.CREDIT_MONTH_BUDGET) || 0,
    dailyCap: Number(env.CREDIT_DAILY_CAP) || 0,
    // Puffer für Fehler/Wiederholungen/Startbestand. Annahme: 10 %.
    bufferPct: Number(env.CREDIT_BUFFER_PCT ?? 10),
    // Tag im Monat, an dem das Guthaben zurückgesetzt wird. Ungeklärt (Kalendermonat oder
    // Vertragsdatum) → nach Vertragsabschluss setzen.
    periodStartDay: Number(env.CREDIT_PERIOD_START_DAY) || 1,

    // Karte: "auto" = Taktung aus Budget und Flottengröße (siehe schedule.js),
    // sonst feste UTC-Stunden, z. B. "1,4,7,10,13,16,19,22".
    pollHoursUtc: env.POLL_HOURS_UTC && env.POLL_HOURS_UTC !== 'auto' ? list(env.POLL_HOURS_UTC, []) : 'auto',
    maxPollsPerDay: Number(env.MAX_POLLS_PER_DAY) || 24,
    minPollsPerDay: Number(env.MIN_POLLS_PER_DAY) || 4,
    // extended (3 Credits) 1×/Tag: current_port, gt, built, draught u. a. (Felder belegt)
    liveExtended: bool(env.LIVE_EXTENDED, true),
    extendedHourUtc: env.EXTENDED_HOUR_UTC !== undefined ? Number(env.EXTENDED_HOUR_UTC) : 22, // nächstgelegener Abruf

    // Historie: Vortag um HISTORY_HOUR_UTC. 1-min-Raster kostet bei MST gleich viel wie 5 min
    // (5 Credits je Kalendertag, belegt). Trial: max. 100 Datensätze je Abfrage (belegt) → gröber.
    historyHourUtc: Number(env.HISTORY_HOUR_UTC ?? 3),
    timegroupMin: Number(env.HISTORY_TIMEGROUP_MIN) || (trial ? 15 : 1),
    lookbackDays: Number(env.HISTORY_LOOKBACK_DAYS) || 3,
    recordLimit: Number(env.HISTORY_RECORD_LIMIT) || (trial ? 100 : 3000),   // belegt: 3.000 (Doku nennt auch 5.000)
    fillStillDays: bool(env.HISTORY_FILL_STILL, true),

    // Verlustfreie Verdichtung von Liegezeiten in der Historie: Punkt behalten, wenn in Fahrt,
    // wenn sich die Position um > COMPRESS_MOVE_SM ändert, oder spätestens alle COMPRESS_MAX_MIN.
    // COMPRESS_MAX_MIN muss < MAX_GAP_HOURS_HISTORY (60 min) bleiben, sonst entstehen Scheinlücken.
    compressStill: bool(env.HISTORY_COMPRESS, true),
    compressMaxMin: Number(env.COMPRESS_MAX_MIN) || 30,
    compressMoveSm: Number(env.COMPRESS_MOVE_SM) || 0.05,

    // Fahrterkennung (Annahmen)
    vMoveKn: Number(env.DETECT_V_KN) || 2,           // wie V_IDLE_KN in emissions.js (EPA 2025)
    dispThreshSm: Number(env.DETECT_DISP_SM) || 0.3, // Schwojkreis großer Yachten ~0,1 sm (Annahme)
    staleHours: Number(env.LIVE_STALE_HOURS) || 6,   // ältere Live-Meldung = kein Treffer

    // Plausibilität
    maxSogKn: Number(env.MAX_PLAUSIBLE_SOG_KN) || 45,
  };
}

module.exports = { loadConfig };
