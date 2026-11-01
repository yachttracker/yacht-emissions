// ── EMISSIONSBERECHNUNG v3 (Rate je AIS-Meldung, kg/h) ───────────────────────
// Methodik: Bottom-up-Verfahren der Fourth IMO GHG Study 2020 (Faber et al. 2021),
// für Yachten erweitert um Antriebsprofil, volumenbasierte Hotellast und Landstrom.
// Ausführlich: Projektdokumente 02_methodik.md, 05_imo4_auszug.md und
// „Berechnungsmethodik_Superyachten.docx“ (Gleichungsnummern unten beziehen sich darauf).
// Jeder Parameter trägt einen Status: belegt (Quelle) / Annahme / ungeklärt.
//
// Rechenkette je Meldung:
//   1. Betriebsphase aus SOG, nav_status und Hafeninfo (berth / anchor / underway / sailing)
//   2. Antriebsleistung W (Admiralitätsformel, IMO Gl. 8)                  [Doc Gl. 1–2]
//   3. Hotellast P_H aus Volumen V (aus GT) und Phasenfaktor              [Doc Gl. 10–12]
//   4. Deckung je Antriebsart: dieselmechanisch / CODAG / dieselelektrisch / Segel [Doc 9a/9b]
//   5. Kraftstoff → CO2, SOx (kraftstoffbezogen); NOx (energiebezogen, mit LLF)   [Doc Gl. 3–7]
//   6. Landstrom im Hafen: Anteil s_L der Hotellast mit Netzfaktor bewertet       [Doc Gl. 13]

const CALC_VERSION = '2026-11-01-v3.2';

const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

const PARAMS = {
  // ── Kraftstoff und Emissionsfaktoren ──
  CF_CO2: 3.206,          // g CO2 / g MDO (inkl. MGO) – belegt: IMO4 Tab. 21, S. 74
  SULPHUR: envNum('FUEL_SULPHUR', 0.001), // Massenanteil S – Annahme: 0,10 % (MARPOL Annex VI Reg. 14, SOx-ECA)
  SOX_FACTOR: 2 * 0.97753, // EF_SOx = 2 · 0,97753 · S – belegt: IMO4 Gl. 15, S. 74
  // NOx [g/kWh] nach Tier (0 / I / II) – belegt: IMO4 Tab. 23, S. 75; Tab. 49, S. 410.
  // Tier III (nur in NECA, Baujahr ≥ 2016) ist ohne Geodaten nicht umgesetzt → wie Tier II (Annahme).
  NOX_ME: { hs: [10.0, 9.8, 7.7], ms: [14.0, 13.0, 10.5], ss: [18.1, 17.0, 14.4] },
  // Ist die Nenndrehzahl n bekannt (data/specs.csv), gilt für Tier I/II die Formel aus IMO4 Tab. 23, S. 75
  // (MARPOL Annex VI Reg. 13): n < 130 → Konstante; 130 ≤ n < 2.000 → a · n^b; n ≥ 2.000 → Konstante.
  // IMO selbst rechnet MSD pauschal bei 500 rpm; die Anwendung je Yacht ist eine eigene Erweiterung
  // (Entscheidung Paul 2026-11-01). Tier 0 hat keine Formel → Tabellenwert der Motorklasse.
  NOX_RPM: { 1: [17.0, 45, -0.2, 9.8], 2: [14.4, 44, -0.23, 7.7] }, // Tier: [n<130, a, b, n≥2000]
  NOX_AUX: 11.2,          // Hilfsdiesel – belegt: IMO4 Tab. 23
  NOX_GAS_TURBINE: 6.1,   // belegt: IMO4 Tab. 23
  // Schwachlastfaktor NOx (Last < 20 %), linear zwischen den Stützstellen – belegt: IMO4 Tab. 20, S. 74
  LLF_NOX: [[0.02, 4.63], [0.10, 1.22], [0.20, 1.00]],

  // ── Spezifischer Verbrauch [g/kWh], MDO, nach Baujahr (≤1983 / 1984–2000 / ≥2001) ──
  // belegt: IMO4 Tab. 19, S. 70–71
  SFC_BASE: { hs: [210, 190, 185], ms: [200, 185, 175], ss: [190, 175, 165], aux: [210, 190, 185] },
  SFC_GAS_TURBINE: 300,   // lastunabhängig – belegt: IMO4 Tab. 19 / Gl. 10
  SFC_CURVE: [0.455, -0.710, 1.280], // SFC_ME = SFC_base · (a·L² + b·L + c) – belegt: IMO4 Gl. 10, S. 71

  // ── Admiralitätsformel – belegt: IMO4 Gl. 8, S. 64; Anhang L, S. 408 ──
  ETA_W: 0.867, ETA_F: 0.917, DELTA_W: 1.0,
  DRAUGHT_EXP: 0.66, SPEED_EXP: 3,
  LOAD_CAP: 0.98,          // Last > 100 % → 98 % – belegt: IMO4 S. 65
  SOG_CAP_FACTOR: 1.5,     // SOG > 1,5 · v_ref → v_ref – belegt: IMO4 S. 65
  ME_OFF_LOAD: 0.07,       // Hauptmaschine < 7 % Last → 0 – Wert belegt: IMO4, Text vor Tab. 20
                           // (S. 73/74, Seitenangabe zu prüfen). Übertragung auf Yachten: Annahme.
  // Mindestlast in Fahrt (v3.1, Entscheidung Paul 2026-10-31, Prüfbericht K2): Fährt die Yacht
  // (> V_IDLE_KN), läuft der Antrieb; eine Last unter 7 % wird auf 7 % angehoben – für alle
  // Antriebsarten gleich. Annahme (physikalisch begründet, nicht belegt); mit Prof. Baumann
  // abzustimmen. ME_MIN_LOAD=0 stellt die IMO-Regel (unter 7 % = 0) wieder her (Sensitivität).
  ME_MIN_LOAD: envNum('ME_MIN_LOAD', 0.07),
  DRAUGHT_RATIO_RANGE: [0.5, 1.5], // unplausible Tiefgangsverhältnisse → Faktor 1 – Annahme

  // ── Betriebsphasen ──
  V_IDLE_KN: 2,            // ≤ 2 kn: liegend (Anker/Hafen) – belegt: SwRI/EPA 2025, EPA-420-R-25-007, Abschn. 2.6.1
  // Hotellast-Phasenfaktoren relativ zur Referenzkurve (Anker) – Annahme nach Marshall (2015):
  // Anker/Hafen 1,0; Fahrt 1,33 (wie im Word-Dokument, Abschn. 3.3)
  PHASE_FACTOR: { berth: 1.0, anchor: 1.0, underway: 1.33, sailing: 1.33 },

  // ── Hotellast P_Anker = a · V^b [kW, V in m³] – eigene Regression über 5 Referenzyachten ≥ 40 m,
  //    R² = 0,90 (02_methodik); Sensitivität über HOTEL_A / HOTEL_B ──
  HOTEL_A: envNum('HOTEL_A', 5.57),
  HOTEL_B: envNum('HOTEL_B', 0.38),

  // ── Landstrom (Variante B, Entscheidung 2026-10-15) ──
  SHORE_SHARE: envNum('SHORE_SHARE', 0),   // Anteil der Hotellast im Hafen über Landstrom – Annahme/Szenario 0 / 0,5 / 1; Standardwert offen
  GRID_EF_KG_KWH: envNum('GRID_EF_KG_KWH', 0.242), // EU-Strommix 2023 – belegt: Ember (2024), European Electricity Review

  // ── Dieselelektrisch ──
  ETA_EL: envNum('ETA_EL', 1.0),          // Verluste Generator/Umrichter/Fahrmotor – ungeklärt, vorläufig 1

  // ── Segelyachten ──
  SAIL_SHARE: envNum('SAIL_SHARE', 0),    // Anteil der Fahrzeit unter Segeln (ohne nav_status 8) – Annahme/Szenario, Standard 0 = Obergrenze

  // ── Kategorie-Standardwerte bei fehlenden Stammdaten (alle Annahme) ──
  V_REF_DEFAULT_KN: 16.7,  // belegt als Flottenmittel: IMO4 Flottentabelle S. 100, Zeile Yacht (Design-Geschwindigkeit)
  BUILD_YEAR_DEFAULT: envNum('BUILD_YEAR_DEFAULT', 2011), // Annahme → SFC-Klasse ab 2001, Tier II
  ENGINE_CLASS_DEFAULT: 'hs', // schnelllaufende Diesel (z. B. MTU Series 4000) – Annahme
  // Klassengrenzen (IMO4 S. 49): SSD ≤ 300 rpm, MSD 300–900 rpm, HSD > 900 rpm – belegt.
  // Klasse je Yacht steht in data/specs.csv (aus der Nenndrehzahl bzw. Modellreihe).
  // GT aus Länge: GT ≈ 0,01513 · L^2,708 – Annahme: eigene log-log-Regression über 7 Yachten
  // (5 Referenzyachten + Dilbar + Azzam, GT aus 02_methodik/03_daten_flotte), R² = 0,97
  GT_FROM_LENGTH: [0.015134, 2.70844],
};

const NAV_ANCHOR = 1, NAV_MOORED = 5, NAV_SAILING = 8;

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

// Index für Baujahresklassen der SFC-Tabelle (IMO4 Tab. 19)
function sfcYearIndex(year) { return year <= 1983 ? 0 : year <= 2000 ? 1 : 2; }
// NOx-Tier nach Baujahr: 0 vor 2000, I 2000–2010, II ab 2011 (IMO4 S. 75)
function noxTierIndex(year) { return year < 2000 ? 0 : year < 2011 ? 1 : 2; }

// NOx-Faktor [g/kWh] der Hauptmaschinen bzw. Gensets: Formel mit Nenndrehzahl, sonst Klassentabelle
function noxFactor(cls, tierIdx, ratedRpm) {
  const f = PARAMS.NOX_RPM[tierIdx];
  if (f && Number.isFinite(ratedRpm) && ratedRpm > 0) {
    const [low, a, b, high] = f;
    if (ratedRpm < 130) return low;
    if (ratedRpm >= 2000) return high;
    return a * Math.pow(ratedRpm, b);
  }
  return (PARAMS.NOX_ME[cls] || PARAMS.NOX_ME.hs)[tierIdx];
}

function sfcLoadCurve(load) {
  const [a, b, c] = PARAMS.SFC_CURVE;
  return a * load * load + b * load + c;
}

function llfNox(load) {
  const pts = PARAMS.LLF_NOX;
  if (load <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    if (load <= x2) return y1 + (y2 - y1) * (load - x1) / (x2 - x1);
  }
  return 1;
}

// Umbautes Volumen V [m³] aus GT: GT = (0,2 + 0,02 · log10 V) · V
// – TONNAGE 1969, Annex I Regel 3 (Primärtext noch zu beschaffen). Bisektion, monoton steigend.
function volumeFromGT(gt) {
  if (!(gt > 0)) return null;
  const f = v => (0.2 + 0.02 * Math.log10(v)) * v - gt;
  let lo = gt / 0.4, hi = gt / 0.2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function gtFromLength(lengthM) {
  const [a, b] = PARAMS.GT_FROM_LENGTH;
  return lengthM > 0 ? a * Math.pow(lengthM, b) : null;
}

// Hotellast-Referenzkurve (vor Anker) [kW]
function hotelLoadRef(volumeM3) {
  return volumeM3 > 0 ? PARAMS.HOTEL_A * Math.pow(volumeM3, PARAMS.HOTEL_B) : 0;
}

// Fallback-Antriebsleistung aus der Länge – ungeklärt, keine Quelle. Nur solange mcr_kw fehlt.
function estimateMCRFromLength(lengthM) {
  return 50 * Math.pow(lengthM, 1.2);
}

// Betriebsphase: SOG zuerst (AIS-nav_status wird manuell gesetzt und ist oft veraltet – Annahme),
// nav_status bzw. Hafeninfo nur zur Unterscheidung Hafen/Anker und für „unter Segeln“.
function operatingPhase(speedKnots, navStatus, ctx = {}) {
  const v = Number(speedKnots) || 0;
  const nav = navStatus === null || navStatus === undefined || navStatus === '' ? null : Number(navStatus);
  if (v <= PARAMS.V_IDLE_KN) {
    if (ctx.atPort === true || nav === NAV_MOORED) return 'berth';
    return 'anchor'; // inkl. nav_status 1 und unbekannt
  }
  if (nav === NAV_SAILING) return 'sailing';
  return 'underway';
}

// Stammdaten mit Standardwerten auflösen; jedes Feld meldet, ob es geschätzt ist
function resolveProfile(yacht) {
  const mcrKnown = Number.isFinite(yacht.mcr_kw) && yacht.mcr_kw > 0;
  const gtKnown = Number.isFinite(yacht.gt) && yacht.gt > 0;
  const yearKnown = Number.isFinite(yacht.build_year) && yacht.build_year > 1800;
  const vrefKnown = Number.isFinite(yacht.vmax_kn) && yacht.vmax_kn > 0;
  const propulsion = yacht.propulsion || 'diesel_mech';
  return {
    propulsion,
    propulsion_estimated: !yacht.propulsion,
    mcr_kw: mcrKnown ? yacht.mcr_kw : estimateMCRFromLength(yacht.length),
    mcr_estimated: !mcrKnown,
    gt: gtKnown ? yacht.gt : gtFromLength(yacht.length),
    gt_estimated: !gtKnown,
    build_year: yearKnown ? yacht.build_year : PARAMS.BUILD_YEAR_DEFAULT,
    build_year_estimated: !yearKnown,
    v_ref_kn: vrefKnown ? yacht.vmax_kn : PARAMS.V_REF_DEFAULT_KN,
    v_ref_estimated: !vrefKnown,
    engine_class: PARAMS.SFC_BASE[yacht.engine_class] ? yacht.engine_class : PARAMS.ENGINE_CLASS_DEFAULT,
    engine_class_estimated: !PARAMS.SFC_BASE[yacht.engine_class],
    rated_rpm: Number.isFinite(yacht.rated_rpm) && yacht.rated_rpm > 0 ? yacht.rated_rpm : null,
    draught_ref_m: Number.isFinite(yacht.draught_ref_m) ? yacht.draught_ref_m : null,
    diesel_kw: Number.isFinite(yacht.diesel_kw) && yacht.diesel_kw > 0 ? yacht.diesel_kw : null, // CODAG
    switch_speed_kn: Number.isFinite(yacht.switch_speed_kn) ? yacht.switch_speed_kn : null,   // CODAG
  };
}

// Antriebsleistung nach Admiralitätsformel [kW] und Last (Anteil an W_ref)
function propulsionPower(prof, speedKnots, draughtM) {
  let v = Number(speedKnots) || 0;
  const vref = prof.v_ref_kn;
  if (v > PARAMS.SOG_CAP_FACTOR * vref) v = vref;
  let tFactor = 1;
  if (draughtM > 0 && prof.draught_ref_m > 0) {
    const ratio = draughtM / prof.draught_ref_m;
    const [lo, hi] = PARAMS.DRAUGHT_RATIO_RANGE;
    if (ratio >= lo && ratio <= hi) tFactor = Math.pow(ratio, PARAMS.DRAUGHT_EXP);
  }
  let w = PARAMS.DELTA_W * prof.mcr_kw * tFactor * Math.pow(v / vref, PARAMS.SPEED_EXP)
        / (PARAMS.ETA_W * PARAMS.ETA_F);
  w = Math.min(w, PARAMS.LOAD_CAP * prof.mcr_kw);
  return { w_kw: w, load: prof.mcr_kw > 0 ? w / prof.mcr_kw : 0, draught_factor: tFactor };
}

// ── Hauptfunktion ───────────────────────────────────────────────────────────
// yacht: Stammdaten aus fleet.js { length, mcr_kw?, vmax_kn?, gt?, build_year?, propulsion?,
//        engine_class?, draught_ref_m?, diesel_kw?, switch_speed_kn? }
// ctx:   { atPort?: boolean (Hafeninfo des Anbieters), draught?: m (AIS), shoreShare?, sailShare? }
// Rückgabe: Raten in kg/h (bzw. kW) für eine Stunde in diesem Zustand.
function calcHourlyEmissions(yacht, speedKnots, navStatus, ctx = {}) {
  const prof = resolveProfile(yacht);
  const phase = operatingPhase(speedKnots, navStatus, ctx);
  const year = prof.build_year;
  const sfcIdx = sfcYearIndex(year);
  const tierIdx = noxTierIndex(year);
  const cls = prof.engine_class;
  const sfcAux = PARAMS.SFC_BASE.aux[sfcIdx];
  const noxMe = noxFactor(cls, tierIdx, prof.rated_rpm);

  // Hotellast
  const volume = volumeFromGT(prof.gt);
  const pHotelRef = hotelLoadRef(volume);
  const pHotel = pHotelRef * (PARAMS.PHASE_FACTOR[phase] ?? 1);
  const shoreShare = phase === 'berth'
    ? Math.min(Math.max(ctx.shoreShare ?? PARAMS.SHORE_SHARE, 0), 1) : 0;
  const pHotelOnboard = pHotel * (1 - shoreShare);
  const shoreKw = pHotel * shoreShare;

  // Antrieb
  let wMain = 0, load = 0;
  if (phase === 'underway' || phase === 'sailing') {
    ({ w_kw: wMain, load } = propulsionPower(prof, speedKnots, ctx.draught));
  }
  if (phase === 'sailing') { wMain = 0; load = 0; } // nav_status 8: unter Segeln, Hauptantrieb aus
  if (prof.propulsion === 'sail_aux' && wMain > 0) {
    const s = Math.min(Math.max(ctx.sailShare ?? PARAMS.SAIL_SHARE, 0), 1);
    wMain *= (1 - s); load *= (1 - s);
  }

  // Mindestlast in Fahrt (siehe PARAMS.ME_MIN_LOAD); unter Segeln (Phase 'sailing') bleibt der Antrieb aus
  if (phase === 'underway' && wMain > 0 && PARAMS.ME_MIN_LOAD > 0 && load < PARAMS.ME_MIN_LOAD && prof.mcr_kw > 0) {
    load = PARAMS.ME_MIN_LOAD;
    wMain = load * prof.mcr_kw;
  }

  let fuelMain = 0, fuelHotel = 0, noxMain = 0, noxHotel = 0; // g/h

  if (prof.propulsion === 'diesel_electric' || prof.propulsion === 'hybrid') {
    // Doc Gl. 9b: Gensets decken Antrieb und Hotellast, laufen nahe Optimum (SFC_base, ohne Lastkurve).
    // Akku nicht simuliert (02_methodik). Gensets mit der Motorklasse und Nenndrehzahl aus data/specs.csv
    // (Regel R4, 2026-11-01; Standard schnelllaufend). Für HSD ist SFC_base gleich dem Hilfsdiesel-Wert.
    const eMain = wMain / PARAMS.ETA_EL;
    const efNox = noxMe;
    const sfcGen = PARAMS.SFC_BASE[cls][sfcIdx];
    fuelMain = eMain * sfcGen;
    fuelHotel = pHotelOnboard * sfcGen;
    noxMain = eMain * efNox;
    noxHotel = pHotelOnboard * efNox;
  } else {
    // Doc Gl. 9a: Hauptmaschine(n) mechanisch + separate Generatoren für die Hotellast
    if (prof.propulsion === 'codag' && wMain > 0) {
      // CODAG – Annahme: Diesel bis zu ihrer Leistung (98 %), ab Umschaltgeschwindigkeit deckt die
      // Gasturbine den Rest (SFC lastunabhängig). Umschaltpunkt fehlt → 80 % v_ref (Annahme).
      const dieselKw = prof.diesel_kw || prof.mcr_kw;
      const switchKn = prof.switch_speed_kn ?? 0.8 * prof.v_ref_kn;
      const wDiesel = Math.min(wMain, PARAMS.LOAD_CAP * dieselKw);
      const wTurbine = (Number(speedKnots) >= switchKn) ? wMain - wDiesel : 0;
      const loadD = wDiesel / dieselKw;
      if (loadD >= PARAMS.ME_OFF_LOAD) {
        fuelMain += wDiesel * PARAMS.SFC_BASE[cls][sfcIdx] * sfcLoadCurve(loadD);
        noxMain += wDiesel * noxMe * llfNox(loadD);
      }
      fuelMain += wTurbine * PARAMS.SFC_GAS_TURBINE;
      noxMain += wTurbine * PARAMS.NOX_GAS_TURBINE;
      wMain = (loadD >= PARAMS.ME_OFF_LOAD ? wDiesel : 0) + wTurbine;
    } else if (load >= PARAMS.ME_OFF_LOAD) {
      fuelMain = wMain * PARAMS.SFC_BASE[cls][sfcIdx] * sfcLoadCurve(load);
      noxMain = wMain * noxMe * llfNox(load);
    } else {
      wMain = 0; // IMO4: unter 7 % Last keine Hauptmaschinenemissionen (nur noch bei ME_MIN_LOAD < 0,07)
    }
    fuelHotel = pHotelOnboard * sfcAux;
    noxHotel = pHotelOnboard * PARAMS.NOX_AUX;
  }

  const fuel = (fuelMain + fuelHotel) / 1000;               // kg/h
  const co2Onboard = fuel * PARAMS.CF_CO2;
  const co2Grid = shoreKw * PARAMS.GRID_EF_KG_KWH;
  return {
    fuel_kg_h: fuel,
    fuel_main_kg_h: fuelMain / 1000,
    fuel_hotel_kg_h: fuelHotel / 1000,
    co2_kg_h: co2Onboard + co2Grid,       // Variante B: Landstrom mit Netzfaktor eingerechnet
    co2_grid_kg_h: co2Grid,
    sox_kg_h: fuel * PARAMS.SOX_FACTOR * PARAMS.SULPHUR,
    nox_kg_h: (noxMain + noxHotel) / 1000,
    phase,
    p_main_kw: wMain,
    p_hotel_kw: pHotel,
    shore_kw: shoreKw,
    me_load: load,
    mcr_kw: prof.mcr_kw,
    mcr_estimated: prof.mcr_estimated,
    gt_used: prof.gt,
    gt_estimated: prof.gt_estimated,
    volume_m3: volume,
    profile_estimated: {
      propulsion: prof.propulsion_estimated, mcr_kw: prof.mcr_estimated, gt: prof.gt_estimated,
      build_year: prof.build_year_estimated, v_ref: prof.v_ref_estimated,
      engine_class: prof.engine_class_estimated,
    },
    engine_class: prof.engine_class,
    calc_version: CALC_VERSION,
  };
}

// Kompatibilität: frühere Signatur (v2) – Last ohne Wirkungsgrade, nur noch für Altaufrufe
function mainEngineLoad(speedKnots, vMaxKnots) {
  const v = Number(speedKnots) || 0;
  if (v <= PARAMS.V_IDLE_KN) return 0;
  return Math.min(Math.pow(v / (vMaxKnots || PARAMS.V_REF_DEFAULT_KN), 3), 1);
}

module.exports = {
  calcHourlyEmissions, operatingPhase, resolveProfile, propulsionPower,
  volumeFromGT, gtFromLength, hotelLoadRef, sfcLoadCurve, llfNox, noxFactor,
  mainEngineLoad, estimateMCRFromLength, PARAMS, CALC_VERSION,
};
