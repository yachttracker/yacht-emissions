// ── Zahlen- und Zeitformate (englisch, UTC wo es um Datengrenzen geht) ───────

const LOCALE = 'en-GB';
const nf = (opts) => new Intl.NumberFormat(LOCALE, opts);
const N0 = nf({ maximumFractionDigits: 0 });
const N1 = nf({ maximumFractionDigits: 1 });
const N2 = nf({ maximumFractionDigits: 2 });

// Masse in kg → passende Einheit (kg, t). Gibt { value, unit, num, text } zurück.
export function mass(kg, { precise = false } = {}) {
  if (kg === null || kg === undefined || !Number.isFinite(Number(kg))) return { value: null, unit: '', text: '–' };
  const v = Number(kg);
  const abs = Math.abs(v);
  let value, unit;
  // Bewusst keine Kilotonnen: "kt" wird im Schiffskontext als Knoten gelesen
  if (abs >= 1000) { value = v / 1000; unit = 't'; }
  else { value = v; unit = 'kg'; }
  const fmt = precise ? N2 : Math.abs(value) >= 100 ? N0 : N1;
  const num = fmt.format(value);
  return { value, unit, num, text: `${num} ${unit}` };
}

// Masse in fester Einheit für eine Achse/Spalte
export function massIn(kg, unit) {
  const div = unit === 't' ? 1000 : 1;
  const v = Number(kg) / div;
  return (Math.abs(v) >= 100 ? N0 : Math.abs(v) >= 10 ? N1 : N2).format(v);
}

export function unitFor(maxKg) {
  const a = Math.abs(Number(maxKg) || 0);
  return a >= 1000 ? 't' : 'kg';
}

export const int = (n) => (Number.isFinite(Number(n)) ? N0.format(Number(n)) : '–');
export const dec1 = (n) => (Number.isFinite(Number(n)) ? N1.format(Number(n)) : '–');
export const pct = (x) => (Number.isFinite(x) ? `${N0.format(Math.round(x * 100))} %` : '–');

export function rate(kgPerH) {
  if (!Number.isFinite(Number(kgPerH))) return '–';
  const v = Number(kgPerH);
  return v >= 1000 ? `${N1.format(v / 1000)} t/h` : `${(v >= 100 ? N0 : N1).format(v)} kg/h`;
}

const DATE = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_SHORT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DATETIME = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });
const TIME = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });

const d = (x) => (x instanceof Date ? x : new Date(x));
export const date = (x) => (x ? DATE.format(d(x)) : '–');
export const dateShort = (x) => (x ? DATE_SHORT.format(d(x)) : '–');
export const dateTime = (x) => (x ? `${DATETIME.format(d(x))} UTC` : '–');
export const time = (x) => (x ? TIME.format(d(x)) : '–');

export function ago(x, now = Date.now()) {
  if (!x) return 'never';
  const s = Math.round((now - d(x).getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} days ago`;
}

export function hours(h) {
  if (!Number.isFinite(Number(h))) return '–';
  const v = Number(h);
  if (v >= 48) return `${N1.format(v / 24)} days`;
  return `${N1.format(v)} h`;
}

const REGION = (() => { try { return new Intl.DisplayNames([LOCALE], { type: 'region' }); } catch { return null; } })();
export function country(code) {
  if (!code) return 'Unknown flag';
  try { return (REGION && REGION.of(code)) || code; } catch { return code; }
}

export function rangeLabel(fromIso, toIso) {
  if (!fromIso || !toIso) return '';
  const a = d(fromIso), b = new Date(d(toIso).getTime() - 1);
  const sameDay = a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  if (sameDay) return `${date(a)}, ${time(a)}–${time(d(toIso))} UTC`;
  return `${dateShort(a)} – ${date(b)}`;
}
