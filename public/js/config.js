// ── Konfiguration des Dashboards ─────────────────────────────────────────────
// Neue Kategorien, Metriken oder Filter werden hier als Eintrag ergänzt;
// Ranking, Legende und Filterleiste lesen nur diese Listen.

// Kategorien = Farbe des Balkens. Heute nur Yachten (blau). Weitere Verursacher oder
// Segmente (z. B. Antrieb/Hotellast ab Modell v3) bekommen hier einen Eintrag; der Balken
// zeichnet so viele Segmente, wie eine Zeile in row.segments mitbringt.
export const CATEGORIES = {
  yacht: { label: 'Yachts', colorVar: '--cat-yacht' },
};

// Metriken des Rankings. field = Summenfeld aus /api/emissions/summary (kg).
export const METRICS = [
  { key: 'co2', label: 'CO₂', long: 'Carbon dioxide (CO₂)', phrase: 'CO₂', field: 'co2_kg_total', enabled: true },
  { key: 'fuel', label: 'Fuel', long: 'Fuel burned', phrase: 'fuel burned', field: 'fuel_kg_total', enabled: true },
  { key: 'nox', label: 'NOₓ', long: 'Nitrogen oxides (NOₓ)', phrase: 'NOₓ', field: 'nox_kg_total', enabled: true },
  { key: 'sox', label: 'SOₓ', long: 'Sulphur oxides (SOₓ)', phrase: 'SOₓ', field: 'sox_kg_total', enabled: true },
  // Reserviert: Methode für den Strahlungsantrieb wird separat festgelegt (Stand 2026-10-18)
  { key: 'erf', label: 'Climate impact (ERF)', long: 'Effective radiative forcing', phrase: 'climate impact', field: null,
    enabled: false, note: 'Method pending' },
];

// Zeiträume (Backend: lib/periods.js). Kalendergrenzen in UTC.
export const PERIODS = [
  { key: 'day', label: 'Day', rolling: 'Last 24 hours', calendar: 'Today (UTC)' },
  { key: 'week', label: 'Week', rolling: 'Last 7 days', calendar: 'This week (UTC, from Monday)' },
  { key: 'month', label: 'Month', rolling: 'Last 30 days', calendar: 'This month (UTC)' },
  { key: 'year', label: 'Year', rolling: 'Last 365 days', calendar: 'This year (UTC)' },
];

// Größenklassen nach Länge (Länge laut Projektliste, ungeprüft)
export const SIZE_CLASSES = [
  { key: 'lt80', label: 'Under 80 m', test: (m) => m < 80 },
  { key: '80-100', label: '80–100 m', test: (m) => m >= 80 && m < 100 },
  { key: '100-120', label: '100–120 m', test: (m) => m >= 100 && m < 120 },
  { key: 'ge120', label: '120 m and longer', test: (m) => m >= 120 },
];

export const COVERAGE_STEPS = [0, 25, 50, 75, 90];

// Filter als Konfigurationsliste. enabled:false = vorbereitet, aber ausgeblendet,
// bis die Stammdaten bzw. Geodaten vorliegen.
export const FILTERS = [
  { key: 'search', type: 'search', label: 'Search', placeholder: 'Yacht or owner', enabled: true },
  { key: 'flag', type: 'select', label: 'Flag', field: 'flag_code', enabled: true },
  { key: 'size', type: 'select', label: 'Length', options: SIZE_CLASSES, field: 'length_m', enabled: true },
  { key: 'minCoverage', type: 'select', label: 'Min. coverage', enabled: true },
  { key: 'propulsion', type: 'select', label: 'Propulsion', field: 'propulsion', enabled: false, needs: 'master data' },
  { key: 'buildYear', type: 'range', label: 'Year built', field: 'build_year', enabled: false, needs: 'master data' },
  { key: 'gt', type: 'range', label: 'Gross tonnage', field: 'gt', enabled: false, needs: 'master data' },
  { key: 'phase', type: 'select', label: 'Operating phase', enabled: false, needs: 'port and coastline geodata' },
  { key: 'region', type: 'select', label: 'Region', enabled: false, needs: 'region geodata' },
];

// Belegstatus je Wert (Projektregel: belegt / Annahme / ungeklärt; dazu Anbieterangabe)
export const STATUS = {
  sourced: { label: 'Sourced', icon: 'check', hint: 'Backed by a cited source' },
  assumption: { label: 'Assumption', icon: 'tilde', hint: 'Estimated or assumed value' },
  unverified: { label: 'Unverified', icon: 'question', hint: 'Not yet checked against a source' },
  provider: { label: 'Provider data', icon: 'antenna', hint: 'Reported by the AIS data provider' },
};

// Hinweis zum Datensatz (Banner); prod = kein Banner
export const DATASET_BANNER = {
  demo: { title: 'Demo data.', text: 'Invented yachts, owners and positions for local development. Not real measurements.' },
  mock: { title: 'Demo data.', text: 'Synthetic positions from the mock provider. Not real measurements.' },
  trial: { title: 'Trial data.', text: 'Provider trial used for calibration. Values may be incomplete.' },
};

export const REFRESH_MS = 5 * 60 * 1000;    // Daten kommen nur wenige Male am Tag hinzu
export const DEFAULTS = { view: 'ranking', period: 'month', mode: 'rolling', metric: 'co2' };
