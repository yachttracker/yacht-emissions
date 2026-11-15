// ── Konfiguration des Dashboards ─────────────────────────────────────────────
// Neue Kategorien, Metriken oder Filter werden hier als Eintrag ergänzt;
// Ranking, Legende und Filterleiste lesen nur diese Listen.

// Kategorien = Farbe des Balkens. Heute nur Yachten (blau). Weitere Verursacher oder
// Segmente (z. B. Antrieb/Hotellast ab Modell v3) bekommen hier einen Eintrag; der Balken
// zeichnet so viele Segmente, wie eine Zeile in row.segments mitbringt.
export const CATEGORIES = {
  yacht: { label: 'Yachts', colorVar: '--cat-yacht' },
};

// Metriken. field = Summenfeld aus /api/emissions/summary (kg).
// select:true = im Auswahlfeld „Metric“ (Ranking); alle enabled-Metriken erscheinen in Tabellenansicht und Detailpanel.
// kind = Größenart für die Einheit (format.js unitOf): mass, co2e, erf (W m⁻²), erfInt (W m⁻²·a).
// Entscheidung Paul 15.11.2026: Auswahl „Global warming potential“ (Standard) und „Climate impact“;
// ergänzt 15.11.2026 (Abgleich Aufgabenstellung, TA 3): Strahlungsantrieb als eigene Größe in W m⁻² bzw. W m⁻²·a.
export const METRICS = [
  // Klimawirkung (Entscheidung Paul 12.11.2026, claude/recherche/erf_methodik_v2.md): berechnet im Browser
  // aus den Summen (public/js/climate.js), Zeithorizont und Faktoren per Schieberegler.
  // 'ghg' = CO2e nur Treibhausgase CO2 + N2O (A); 'all' = CO2e mit SO2 und NOx (B);
  // 'erfInt' = integrierter Strahlungsantrieb (W m⁻²·a); 'erfNow' = Strahlungsantrieb am Ende des Zeitraums (W m⁻²).
  { key: 'ghg', label: 'Global warming potential', long: 'Global warming potential: CO₂ + N₂O', phrase: 'global warming potential',
    climate: 'ghg', kind: 'co2e', unitName: 't CO₂e', enabled: true, select: true,
    hint: 'Greenhouse gases CO₂ and N₂O, weighted by their global warming potential (GWP), in tonnes of CO₂ equivalent.' },
  { key: 'climate', label: 'Climate impact', long: 'Climate impact incl. SO₂ and NOₓ', phrase: 'climate impact',
    climate: 'all', kind: 'co2e', unitName: 't CO₂e', enabled: true, select: true,
    hint: 'CO₂ and N₂O plus the short-lived effects of sulphate (SO₂) and NOₓ, each weighted by its GWP over the horizon, in tonnes of CO₂ equivalent. Not a radiative forcing; see the two radiative forcing metrics for that.' },
  { key: 'erf_int', label: 'Radiative forcing, time-integrated', long: 'Radiative forcing integrated over the horizon, all substances',
    phrase: 'time-integrated radiative forcing', climate: 'erfInt', kind: 'erfInt', unitName: 'W m⁻²·a', enabled: true, select: true,
    hint: 'Radiative forcing caused by the CO₂, N₂O, sulphate (SO₂) and NOₓ emitted in the period, summed over the horizon (W m⁻² × years). Effective radiative forcing for SO₂, radiative forcing for NOₓ.' },
  { key: 'erf', label: 'Radiative forcing at period end', long: 'Radiative forcing at the end of the period, all substances',
    phrase: 'radiative forcing at the end of the period', climate: 'erfNow', kind: 'erf', unitName: 'W m⁻²', enabled: true, select: false,   // nicht im Ranking: am Periodenende meist negativ (Sulfat), Rangfolge wäre irreführend
    hint: 'Radiative forcing at the end of the period caused by the emissions in the period (W m⁻²). Short-lived sulphate (cooling) and ozone from NOₓ (warming) dominate; independent of the horizon.' },
  { key: 'co2', label: 'CO₂', long: 'Carbon dioxide (CO₂)', phrase: 'CO₂', field: 'co2_kg_total', enabled: true },
  { key: 'fuel', label: 'Fuel', long: 'Fuel burned', phrase: 'fuel burned', field: 'fuel_kg_total', enabled: true },
  { key: 'nox', label: 'NOₓ as NO₂', long: 'Nitrogen oxides (NOₓ), mass as NO₂', phrase: 'NOₓ (as NO₂)', field: 'nox_kg_total', enabled: true },   // IMO4-Faktoren in g NO2/kWh
  { key: 'sox', label: 'SOₓ as SO₂', long: 'Sulphur oxides (SOₓ), mass as SO₂', phrase: 'SOₓ (as SO₂)', field: 'sox_kg_total', enabled: true },   // IMO4 Gl. 15: Masse als SO2
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
  indication: { label: 'Indication', icon: 'tilde', hint: 'Single source, inference or conflict resolved by a documented rule' },
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

// Funktionsschalter. map:false = keine Karte: kein Map-Tab, keine Routenkarte im Detailpanel,
// Leaflet und Kartenkacheln werden nie geladen. Wieder einschalten: map auf true setzen.
// (Stand 2026-10-31: aus, solange viele Positionen alt sind und die Datenlage klein ist.)
export const FEATURES = { map: false };

export const REFRESH_MS = 5 * 60 * 1000;    // Daten kommen nur wenige Male am Tag hinzu
export const DEFAULTS = { view: 'ranking', period: 'month', mode: 'rolling', metric: 'ghg' };
