// ── Zeitfenster für Summary und History ─────────────────────────────────────
// Parameter (alle optional):
//   period = day | week | month | year            (Standard day, wie bisher)
//   mode   = rolling | calendar                    (Standard rolling, wie bisher)
//   from, to = YYYY-MM-DD (UTC, "to" inklusive) oder ISO-Zeitpunkt mit Zone (Z/±hh:mm)
//            → freies Fenster, hat Vorrang vor period/mode
// Rollierend: day 24 h, week 7 d, month 30 d (wie bisher), year 365 d (neu).
// Kalender: Beginn des aktuellen UTC-Tags, der ISO-Woche (Montag), des Monats bzw. Jahres
// bis jetzt. UTC, weil vessel_days in UTC-Tagen arbeitet (Annahme: für Nutzer in Europa
// verschiebt sich die Tagesgrenze um 1–2 h).
// Das Fenster endet nie in der Zukunft (t1 ≤ jetzt).

const HOURS = { day: 24, week: 24 * 7, month: 24 * 30, year: 24 * 365 };
const MAX_CUSTOM_DAYS = 731;   // Historie reicht 2 Jahre zurück (07_abruflogik) → mehr ist sinnlos
const H_MS = 3600000;
const DAY_MS = 24 * H_MS;

class WindowError extends Error {}

function parseBound(v, edge) {
  const s = String(v).trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) {
    const t = Date.UTC(+date[1], +date[2] - 1, +date[3]);
    const back = new Date(t);
    if (back.getUTCMonth() !== +date[2] - 1 || back.getUTCDate() !== +date[3]) throw new WindowError(`invalid date: ${s}`);
    return edge === 'end' ? t + DAY_MS : t;           // "to" als Datum = ganzer Tag inklusive
  }
  // Volle Zeitpunkte nur mit Zonenangabe, sonst hinge das Ergebnis von der Server-Zeitzone ab
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    throw new WindowError(`use YYYY-MM-DD or an ISO timestamp with zone (Z or ±hh:mm): ${s}`);
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new WindowError(`invalid timestamp: ${s}`);
  return t;
}

function calendarStart(period, nowMs) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  if (period === 'year') return Date.UTC(y, 0, 1);
  if (period === 'month') return Date.UTC(y, m, 1);
  const today = Date.UTC(y, m, day);
  if (period === 'week') return today - ((d.getUTCDay() + 6) % 7) * DAY_MS;   // ISO-Woche: Montag
  return today;
}

// Liefert { t0, t1 (Date), period, mode, period_h }.
function resolveWindow(q = {}, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (q.from !== undefined || q.to !== undefined) {
    if (q.from === undefined) throw new WindowError('from is required when to is given');
    const t0 = parseBound(q.from, 'start');
    const t1 = Math.min(q.to !== undefined ? parseBound(q.to, 'end') : nowMs, nowMs);
    if (!(t0 < t1)) throw new WindowError('empty window: from must be before to and before now');
    if (t1 - t0 > MAX_CUSTOM_DAYS * DAY_MS) throw new WindowError(`window longer than ${MAX_CUSTOM_DAYS} days`);
    return { t0: new Date(t0), t1: new Date(t1), period: 'custom', mode: 'custom', period_h: (t1 - t0) / H_MS };
  }
  // Unbekannte Werte fallen wie bisher auf "day" zurück
  const period = Object.prototype.hasOwnProperty.call(HOURS, q.period) ? q.period : 'day';
  const mode = q.mode === 'calendar' ? 'calendar' : 'rolling';
  const t0 = mode === 'calendar' ? calendarStart(period, nowMs) : nowMs - HOURS[period] * H_MS;
  // Kalendertag direkt nach Mitternacht: Fenster mindestens 1 ms, damit es nicht leer ist
  const t0Safe = Math.min(t0, nowMs - 1);
  return {
    t0: new Date(t0Safe), t1: new Date(nowMs), period, mode,
    period_h: mode === 'rolling' ? HOURS[period] : (nowMs - t0Safe) / H_MS,
  };
}

// Schlüssel für den Antwort-Cache (gleiche Parameter → gleicher Eintrag)
function windowKey(q = {}) {
  return JSON.stringify([q.period || 'day', q.mode || 'rolling', q.from || '', q.to || '']);
}

module.exports = { resolveWindow, windowKey, WindowError, HOURS, MAX_CUSTOM_DAYS };
