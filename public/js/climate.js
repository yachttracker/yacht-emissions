// ── Klimawirkung: CO2-Äquivalente (GWP) und Strahlungsantrieb (ERF/RF) ───────
// Methode: lineares Impulsantwortmodell, wie IPCC AR6 Kap. 7.6 und Fuglestvedt et al. 2010.
// Projektdokument: claude/recherche/erf_methodik_v2.md (Entscheidungen Paul 12.11.2026).
// Status je Wert: belegt (Quelle) / abgeleitet (eigene Rechnung) / Annahme.
// Reines Rechenmodul ohne DOM → auch unter Node testbar (test/climate.test.mjs).

// CO2 – Strahlungseffizienz 1,33e-5 W m-2 ppb-1 (belegt: AR6 7.6.1.1, Tab. 7.SM.7);
// 1 ppm = 2,124 GtC (Standardwert) → A je kg CO2 (abgeleitet).
const KG_CO2_PER_PPB = 2.124e12 * (44.009 / 12.011) / 1000;
export const A_CO2 = 1.33e-5 / KG_CO2_PER_PPB;                 // ≈ 1,709e-15 W m-2 kg-1
// Impulsantwort CO2 (belegt: Joos et al. 2013, Tab. 5, IRF_CO2)
export const CO2_A = [0.2173, 0.2240, 0.2824, 0.2763];
export const CO2_TAU = [394.4, 36.54, 4.304];

// N2O – Lebensdauer 109 a, AGWP100 24,5 pW m-2 a kg-1 (belegt: AR6 Tab. 7.SM.7) → A (abgeleitet).
export const N2O_TAU = 109;
export const A_N2O = 24.5e-12 / (N2O_TAU * (1 - Math.exp(-100 / N2O_TAU)));
// N2O-Emission aus dem Kraftstoff: 0,034 g/kWh (HSD, MDO; belegt: IMO4 Tab. 59, S. 414)
// geteilt durch SFC 185 g/kWh (Annahme: typischer Wert IMO4 Tab. 19) → kg N2O je kg Kraftstoff.
export const N2O_PER_KG_FUEL = 0.034 / 185;

// SO2 (als SO2, wie SOx in emissions.js: 2 · 0,97753 · S) – Sulfat, τ 0,011 a (belegt: Fuglestvedt 2010 Tab. 5/6).
// F_SS je (kg/a): Skeie et al. 2024 0,073 W m-2 für 8,7 Tg SO2/a weniger → −8,4e-12 (abgeleitet).
// Spanne: Skeie-Modelle −6,6 … −10,2; Jordan & Henry 2024 −14,0; Yoshioka 2024 −16,0; Quaglia & Visioni 2024 −16,7.
export const SO2_TAU = 0.011;
export const SO2_DEFAULT = -8.4;                 // mW m-2 je Tg SO2/a
export const SO2_RANGE = [-16.7, -6.6];

// NOx – drei Terme je kg N, F_SS in W m-2 je (kg N/a); RF (nicht ERF).
// kurzlebiges O3 τ 0,267 a (belegt: Fuglestvedt 2010 S. 4663); CH4 und methaninduziertes O3 mit τ_PM.
export const NOX_N_PER_NO2 = 14.007 / 46.006;    // emissions.js rechnet NOx als NO2
export const NOX_O3_TAU = 0.267;
export const NOX_SETS = {
  holmes2014:      { label: 'Holmes et al. 2014 (with plume chemistry)', o3: 3.4e-12, ch4: -5.7e-12, o3pm: -1.7e-12, tau: 12 },   // belegt (Abstract); τ 12 a Annahme
  eyring2007:      { label: 'Eyring et al. 2007', o3: 3.16e-12, ch4: -4.52e-12, o3pm: -1.88e-12, tau: 12.2 },                       // belegt: Fuglestvedt 2010 Tab. 3
  endresen2003:    { label: 'Endresen et al. 2003', o3: 7.99e-12, ch4: -7.71e-12, o3pm: -3.20e-12, tau: 10.2 },
  fuglestvedt2008: { label: 'Fuglestvedt et al. 2008', o3: 7.19e-12, ch4: -7.56e-12, o3pm: -1.88e-12, tau: 10.2 },
};
export const NOX_DEFAULT = 'holmes2014';

export const DEFAULTS = { horizon: 100, so2: SO2_DEFAULT, nox: NOX_DEFAULT };
export const HORIZON_RANGE = [10, 100];

const ex = Math.exp;

// ── AGWP (W m-2 a je kg) ─────────────────────────────────────────────────────
export function agwpCO2(H) {
  return A_CO2 * (CO2_A[0] * H + CO2_TAU.reduce((s, t, i) => s + CO2_A[i + 1] * t * (1 - ex(-H / t)), 0));
}
const agwpPulse = (A, tau, H) => A * tau * (1 - ex(-H / tau));
// Ein-Jahres-Schritt mit Aufbau im Jahr 1 und Abklingen danach (Fuglestvedt 2010, Gl. 10–13)
const agwpStep = (Fss, tau, H) => Fss * ((1 - tau * (1 - ex(-1 / tau))) + tau * (1 - ex(-1 / tau)) * (1 - ex(-(H - 1) / tau)));
// methaninduziertes O3: nur Abklingen ab Jahr 1 (Gl. 14)
const agwpDecay = (Fss, tau, H) => Fss * (1 - ex(-1 / tau)) * tau * (1 - ex(-(H - 1) / tau));

function noxSet(key) { return NOX_SETS[key] || NOX_SETS[NOX_DEFAULT]; }

// GWP je kg (CO2 = 1). NOx je kg NO2.
export function gwp(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const H = o.horizon, base = agwpCO2(H), n = noxSet(o.nox);
  const so2Fss = o.so2 * 1e-3 / 1e9;            // mW je Tg/a → W m-2 je kg/a
  const noxN = (agwpStep(n.o3, NOX_O3_TAU, H) + agwpDecay(n.o3pm, n.tau, H) + agwpStep(n.ch4, n.tau, H)) / base;
  return {
    co2: 1,
    n2o: agwpPulse(A_N2O, N2O_TAU, H) / base,
    so2: agwpPulse(so2Fss / SO2_TAU, SO2_TAU, H) / base,
    nox: noxN * NOX_N_PER_NO2,
  };
}

// CO2e je Stoff für eine Zeile der Summary (kg). scope 'ghg' = nur Treibhausgase, 'all' = mit SO2 und NOx.
export function co2eParts(row, opts = {}) {
  const g = gwp(opts);
  const fuel = Number(row.fuel_kg_total) || 0;
  return {
    co2: (Number(row.co2_kg_total) || 0),
    n2o: fuel * N2O_PER_KG_FUEL * g.n2o,
    so2: (Number(row.sox_kg_total) || 0) * g.so2,
    nox: (Number(row.nox_kg_total) || 0) * g.nox,
  };
}
export function co2e(row, scope = 'all', opts = {}) {
  const p = co2eParts(row, opts);
  return scope === 'ghg' ? p.co2 + p.n2o : p.co2 + p.n2o + p.so2 + p.nox;
}

// ── Nachwirkung: Strahlungsantrieb (W m-2) der im Zeitraum emittierten Mengen ──
// Annahme: Emission gleichmäßig über den Zeitraum der Länge D (Jahre) verteilt (exakt für konstante Rate).
// t = Jahre nach Ende des Zeitraums. Rückgabe je Stoff und Summe.
function stepThenDecay(FssRate, tau, D, t) {
  return FssRate * (1 - ex(-D / tau)) * ex(-t / tau);   // Aufbau während D, danach Abklingen
}
export function afterEffect(row, D, t, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = noxSet(o.nox);
  const d = Math.max(D, 1 / 8760);
  const rate = (kg) => (Number(kg) || 0) / d;           // kg/a
  const co2r = rate(row.co2_kg_total);
  let co2 = A_CO2 * CO2_A[0] * co2r * d;                 // Dauerteil
  CO2_TAU.forEach((tau, i) => { co2 += stepThenDecay(A_CO2 * CO2_A[i + 1] * tau * co2r, tau, d, t); });
  const n2o = stepThenDecay(A_N2O * N2O_TAU * rate((Number(row.fuel_kg_total) || 0) * N2O_PER_KG_FUEL), N2O_TAU, d, t);
  const so2 = stepThenDecay(o.so2 * 1e-12 * rate(row.sox_kg_total), SO2_TAU, d, t);
  const nN = rate(row.nox_kg_total) * NOX_N_PER_NO2;
  const nox = stepThenDecay(n.o3 * nN, NOX_O3_TAU, d, t) + stepThenDecay((n.ch4 + n.o3pm) * nN, n.tau, d, t);
  return { co2, n2o, so2, nox, total: co2 + n2o + so2 + nox };
}
