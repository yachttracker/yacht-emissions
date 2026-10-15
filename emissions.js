// ── EMISSIONSBERECHNUNG (Rate je AIS-Meldung) ───────────────────────────────
// Jeder Parameter trägt einen Status: belegt (mit Quelle) / Annahme / ungeklärt.
// Ausführliche Begründung: Projektdokument 02_methodik.md.
//
// Rechenweg:
//   1. MCR [kW]: aus Yacht-Stammdaten (mcr_kw), sonst Fallback-Schätzung aus Länge
//   2. Hauptmaschinenlast: Propellergesetz  Last = (v / v_max)^3, gedeckelt auf 1
//      v <= 2 kn oder nav_status 1/5 (vor Anker / festgemacht) → Hauptmaschine aus
//   3. Hotel-/Hilfsleistung: P_aux = 0,05 × MCR, konstant (auch im Hafen)
//   4. Kraftstoff = P × SFC
//   5. CO2, SO2: kraftstoffbezogen;  NOx: leistungsbezogen (g/kWh)

const CALC_VERSION = '2026-10-15-v2';

const PARAMS = {
  // CO2-Umrechnungsfaktor Diesel/Gas Oil (ISO 8217 DMX–DMB) = MGO/MDO
  // belegt: IMO Res. MEPC.364(79), Abs. 2.2.1, Cf = 3,206 t CO2 / t Kraftstoff
  CF_CO2: 3.206,

  // Schwefelgehalt MGO (Massenanteil)
  // Annahme: 0,10 % = MARPOL Annex VI Reg. 14 Grenzwert in SOx-ECAs (seit 2015).
  // Global zulässig wären 0,50 % (seit 2020) → obere Grenze für Sensitivität.
  SULPHUR: Number(process.env.FUEL_SULPHUR) || 0.001,

  // SO2 je kg Kraftstoff = 2 × S (Molmasse SO2 64 / S 32, vollständige Oxidation)
  // belegt (Stöchiometrie). IMO rechnet mit 97,753 % Umsetzung → in Arbeit prüfen.
  SO2_PER_S: 2,

  // NOx [g/kWh]
  // Wert = MARPOL Annex VI Reg. 13 Tier-II-Grenzwert 44 × n^-0,23 bei n = 1800 rpm
  // (≈ 7,85 g/kWh; typische Nenndrehzahl MTU Series 4000 für Displacement-Yachten
  // 1600–1800 rpm, MTU-Broschüre 2014).
  // Annahme: alle Motoren Tier II und genau am Grenzwert (ältere Yachten vor 2011:
  // Tier I, 45 × n^-0,2 ≈ 10,0 g/kWh; Neubauten ab 2021 in NECAs Tier III).
  NOX_G_KWH: 44 * Math.pow(1800, -0.23),

  // SFC [g/kWh]
  // Hauptmaschine: belegt nur für Nennleistung: MTU Series 4000 Yacht „down to
  // 194 g/kWh at rated power“ (MTU 2014). Teillast-SFC höher → ungeklärt.
  SFC_MAIN: 194,
  // Generatoren: Annahme 210 g/kWh (Teillastbetrieb), keine Quelle.
  SFC_AUX: 210,

  // Hilfs-/Hotelleistung als Anteil der Antriebsleistung
  // Formel belegt: EEDI P_AE = 0,05 × P_ME bei P_ME < 10 000 kW (MEPC.364(79),
  // Abs. 2.2.5.6.2) – gilt für Frachtschiffe auf See. Übertragung auf Yachten und
  // Anwendung auch vor Anker/im Hafen: Annahme. ABS (2026) nennt Hotellast ≈ Hälfte
  // des Jahresenergiebedarfs großer Yachten → Sensitivität nötig.
  AUX_SHARE: Number(process.env.AUX_SHARE) || 0.05,

  // Geschwindigkeit, unter der die Hauptmaschine als aus gilt
  // belegt: SwRI/EPA (2025), EPA-420-R-25-007, Abschn. 2.6.1: ≤ 2 kn = vor Anker,
  // festgemacht oder ohne Antrieb.
  V_IDLE_KN: 2,

  // Höchstgeschwindigkeit, falls je Yacht nicht hinterlegt
  // Annahme: 16 kn (keine Quelle) → je Yacht nachtragen.
  V_MAX_DEFAULT_KN: 16,
};

// AIS Navigational Status: 1 = at anchor, 5 = moored
const NAV_STATIONARY = new Set([1, 5]);

// Fallback-MCR aus der Länge: ungeklärt, keine Quelle. Nur nutzen, solange mcr_kw fehlt.
function estimateMCRFromLength(lengthM) {
  return 50 * Math.pow(lengthM, 1.2);
}

function mainEngineLoad(speedKnots, vMaxKnots, navStatus) {
  const v = Number(speedKnots) || 0;
  if (v <= PARAMS.V_IDLE_KN) return 0;
  if (navStatus !== null && navStatus !== undefined && NAV_STATIONARY.has(Number(navStatus))) return 0;
  const ratio = v / (vMaxKnots || PARAMS.V_MAX_DEFAULT_KN);
  return Math.min(Math.pow(ratio, 3), 1);
}

// yacht: { length, mcr_kw?, vmax_kn? }
function calcHourlyEmissions(yacht, speedKnots, navStatus) {
  const mcrKnown = Number.isFinite(yacht.mcr_kw) && yacht.mcr_kw > 0;
  const mcr = mcrKnown ? yacht.mcr_kw : estimateMCRFromLength(yacht.length);

  const load = mainEngineLoad(speedKnots, yacht.vmax_kn, navStatus);
  const pMainKw = mcr * load;
  const pAuxKw = mcr * PARAMS.AUX_SHARE;

  const mainFuelKgH = pMainKw * PARAMS.SFC_MAIN / 1000;
  const auxFuelKgH = pAuxKw * PARAMS.SFC_AUX / 1000;
  const fuel = mainFuelKgH + auxFuelKgH;

  return {
    fuel_kg_h: fuel,
    co2_kg_h: fuel * PARAMS.CF_CO2,
    sox_kg_h: fuel * PARAMS.SULPHUR * PARAMS.SO2_PER_S,
    nox_kg_h: (pMainKw + pAuxKw) * PARAMS.NOX_G_KWH / 1000,
    me_load: load,
    mcr_kw: mcr,
    mcr_estimated: !mcrKnown,
    calc_version: CALC_VERSION,
  };
}

module.exports = { calcHourlyEmissions, mainEngineLoad, estimateMCRFromLength, PARAMS, CALC_VERSION };
