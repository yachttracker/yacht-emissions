// Tests für emissions.js v3: Rechenbeispiel aus „Berechnungsmethodik_Superyachten.docx“ (Fälle A–D)
// plus Grenzfälle. Aufruf: node --test test/emissions.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../emissions');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} statt ${expected} (±${tol})`);

// Beispielyacht aus dem Dokument (Abschn. 4): 8.000 kW, v_ref 18 kn, GT 5.000, Baujahr 2012, HSD
const example = { length: 70, mcr_kw: 8000, vmax_kn: 18, gt: 5000, build_year: 2012, propulsion: 'diesel_mech' };

test('Volumen aus GT (TONNAGE 1969) und Hotellast-Referenz', () => {
  const v = E.volumeFromGT(5000);
  near(v, 17550, 10, 'V aus GT 5.000');
  near((0.2 + 0.02 * Math.log10(v)) * v, 5000, 0.01, 'Rückrechnung GT');
  near(E.hotelLoadRef(v), 228, 1, 'P_H,ref');
});

test('Fall A: Fahrt 12 kn, dieselmechanisch', () => {
  const r = E.calcHourlyEmissions(example, 12, 0);
  assert.equal(r.phase, 'underway');
  near(r.p_main_kw, 2982, 1, 'W_ME');
  near(r.me_load, 0.373, 0.001, 'Last');
  near(r.fuel_main_kg_h, 595, 1, 'FC Hauptmaschine');
  near(r.p_hotel_kw, 304, 1, 'Hotellast Fahrt');
  near(r.fuel_kg_h, 651, 1, 'FC gesamt');
  near(r.co2_kg_h, 2087, 3, 'CO2');
  near(r.sox_kg_h, 1.27, 0.01, 'SOx');
  near(r.nox_kg_h, 26.4, 0.1, 'NOx');
  assert.equal(r.co2_grid_kg_h, 0);
});

test('Fall B: vor Anker', () => {
  const r = E.calcHourlyEmissions(example, 0.3, 1);
  assert.equal(r.phase, 'anchor');
  assert.equal(r.p_main_kw, 0);
  near(r.fuel_kg_h, 42.2, 0.3, 'FC');
  near(r.co2_kg_h, 135, 1, 'CO2');
  near(r.nox_kg_h, 2.6, 0.05, 'NOx');
  near(r.sox_kg_h, 0.08, 0.005, 'SOx');
});

test('Fall C: Hafen mit 50 % Landstrom', () => {
  const r = E.calcHourlyEmissions(example, 0, 5, { shoreShare: 0.5 });
  assert.equal(r.phase, 'berth');
  near(r.fuel_kg_h, 21.1, 0.2, 'FC Generatoren');
  near(r.co2_grid_kg_h, 27.6, 0.2, 'CO2 Netz');
  // Dokument nennt 96 kg (Summe gerundeter Teilwerte 68 + 28); exakt ≈ 95,4 kg
  near(r.co2_kg_h, 95.4, 0.3, 'CO2 gesamt');
  // Ohne Landstrom wie Fall B
  const r0 = E.calcHourlyEmissions(example, 0, 5);
  near(r0.co2_kg_h, 135, 1, 'Hafen ohne Landstrom');
  // Landstrom gilt nur im Hafen, nicht vor Anker
  const ra = E.calcHourlyEmissions(example, 0, 1, { shoreShare: 0.5 });
  assert.equal(ra.co2_grid_kg_h, 0);
});

test('Hafeninfo des Anbieters setzt Phase Hafen', () => {
  assert.equal(E.calcHourlyEmissions(example, 0, null, { atPort: true }).phase, 'berth');
  assert.equal(E.calcHourlyEmissions(example, 0, null).phase, 'anchor');
});

test('Fall D: dieselbe Yacht dieselelektrisch (η_el = 1)', () => {
  const r = E.calcHourlyEmissions({ ...example, propulsion: 'diesel_electric' }, 12, 0);
  near(r.fuel_kg_h, 608, 1, 'FC');
  near(r.co2_kg_h, 1948, 3, 'CO2');
  near(r.sox_kg_h, 1.19, 0.01, 'SOx');
  assert.ok(r.co2_kg_h < E.calcHourlyEmissions(example, 12, 0).co2_kg_h, 'dieselelektrisch günstiger als A');
});

test('IMO-Regeln: Mindestlast 7 % in Fahrt (v3.1), Deckel 98 %, SOG > 1,5 v_ref', () => {
  // 7 kn bei v_ref 18: Last ≈ 0,074 → unverändert; 6,5 kn → ≈ 0,069 → auf 7 % angehoben
  assert.ok(E.calcHourlyEmissions(example, 7, 0).fuel_main_kg_h > 0);
  const slow = E.calcHourlyEmissions(example, 6.5, 0);
  near(slow.me_load, 0.07, 1e-12, 'Mindestlast');
  near(slow.p_main_kw, 0.07 * 8000, 1e-9, 'W = 7 % MCR');
  assert.ok(slow.fuel_main_kg_h > 0);
  // kein Sprung mehr zwischen 6 und 6,5 kn; dieselelektrisch und dieselmechanisch gleich behandelt
  const dm6 = E.calcHourlyEmissions(example, 6, 0), de6 = E.calcHourlyEmissions({ ...example, propulsion: 'diesel_electric' }, 6, 0);
  assert.ok(dm6.fuel_main_kg_h > 0 && de6.fuel_main_kg_h > 0);
  near(dm6.p_main_kw, de6.p_main_kw, 1e-9, 'gleiche Antriebsleistung');
  // liegend (≤ 2 kn) bleibt der Antrieb aus
  assert.equal(E.calcHourlyEmissions(example, 1.5, 0).fuel_main_kg_h, 0);
  // IMO-Originalregel (Sensitivität): ME_MIN_LOAD = 0 → unter 7 % keine Hauptmaschinenemissionen
  const saved = E.PARAMS.ME_MIN_LOAD;
  try {
    E.PARAMS.ME_MIN_LOAD = 0;
    assert.equal(E.calcHourlyEmissions(example, 6.5, 0).fuel_main_kg_h, 0);
  } finally { E.PARAMS.ME_MIN_LOAD = saved; }
  const fast = E.calcHourlyEmissions(example, 20, 0);
  near(fast.me_load, 0.98, 1e-9, 'Deckel 98 %');
  const glitch = E.calcHourlyEmissions(example, 40, 0); // > 27 kn → durch v_ref ersetzt
  near(glitch.p_main_kw, Math.min(8000 / (0.867 * 0.917), 0.98 * 8000), 1e-6, 'SOG-Ausreißer');
});

test('Schwachlastfaktor NOx (IMO Tab. 20)', () => {
  near(E.llfNox(0.01), 4.63, 1e-9, '≤ 2 %');
  near(E.llfNox(0.10), 1.22, 1e-9, '10 %');
  near(E.llfNox(0.15), 1.11, 1e-9, '15 % interpoliert');
  near(E.llfNox(0.5), 1.0, 1e-9, '50 %');
});

test('NOx-Tier und SFC-Klasse nach Baujahr', () => {
  const old = E.calcHourlyEmissions({ ...example, build_year: 1995 }, 12, 0);
  const neu = E.calcHourlyEmissions(example, 12, 0);
  assert.ok(old.fuel_kg_h > neu.fuel_kg_h, 'älterer Motor verbraucht mehr (190 vs 185)');
  assert.ok(old.nox_kg_h > neu.nox_kg_h, 'Tier 0/I > Tier II');
});

test('Tiefgang: Faktor (t/t_ref)^0,66, unplausible Werte ignoriert', () => {
  const y = { ...example, draught_ref_m: 4 };
  const base = E.calcHourlyEmissions(y, 12, 0);
  const deep = E.calcHourlyEmissions(y, 12, 0, { draught: 4.4 });
  near(deep.p_main_kw / base.p_main_kw, Math.pow(1.1, 0.66), 1e-9, 'Tiefgangsfaktor');
  near(E.calcHourlyEmissions(y, 12, 0, { draught: 25 }).p_main_kw, base.p_main_kw, 1e-9, 'unplausibel → 1');
});

test('Segelyacht: nav_status 8 ohne Hauptantrieb, Segelanteil als Szenario', () => {
  const sail = { ...example, propulsion: 'sail_aux' };
  const r8 = E.calcHourlyEmissions(sail, 10, 8);
  assert.equal(r8.phase, 'sailing');
  assert.equal(r8.fuel_main_kg_h, 0);
  assert.ok(r8.fuel_hotel_kg_h > 0, 'Hotellast läuft weiter');
  const motor = E.calcHourlyEmissions(sail, 12, 0);
  const half = E.calcHourlyEmissions(sail, 12, 0, { sailShare: 0.5 });
  assert.ok(half.fuel_main_kg_h < motor.fuel_main_kg_h);
});

test('CODAG: Gasturbine erst ab Umschaltgeschwindigkeit', () => {
  const codag = { length: 180, mcr_kw: 70000, diesel_kw: 18000, vmax_kn: 30, gt: 13136,
                  build_year: 2013, propulsion: 'codag', switch_speed_kn: 20 };
  const slow = E.calcHourlyEmissions(codag, 15, 0);
  const fast = E.calcHourlyEmissions(codag, 25, 0);
  assert.ok(slow.fuel_main_kg_h > 0);
  assert.ok(fast.fuel_main_kg_h > slow.fuel_main_kg_h * 3, 'Turbine erhöht Verbrauch deutlich');
});

test('Fehlende Stammdaten: Kategorie-Standardwerte werden gemeldet', () => {
  const r = E.calcHourlyEmissions({ length: 100 }, 12, 0);
  assert.equal(r.mcr_estimated, true);
  assert.equal(r.gt_estimated, true);
  assert.deepEqual(r.profile_estimated, { propulsion: true, mcr_kw: true, gt: true, build_year: true, v_ref: true, engine_class: true });
  for (const k of ['fuel_kg_h', 'co2_kg_h', 'nox_kg_h', 'sox_kg_h']) assert.ok(Number.isFinite(r[k]) && r[k] > 0, k);
  near(E.gtFromLength(118.8), 6188 * Math.pow(118.8 / 118, 2.70844), 5, 'GT-Fallback');
});

test('Nie negativ, nie NaN bei ungültigen Eingaben', () => {
  for (const [s, n] of [[null, null], [undefined, '5'], ['abc', 1], [-3, 0], [0, '']]) {
    const r = E.calcHourlyEmissions(example, s, n);
    for (const k of ['fuel_kg_h', 'co2_kg_h', 'nox_kg_h', 'sox_kg_h']) {
      assert.ok(Number.isFinite(r[k]) && r[k] >= 0, `${k} bei (${s}, ${n})`);
    }
  }
});

test('v3.2: NOx mit Nenndrehzahl (IMO4 Tab. 23) und Motorklasse MSD', () => {
  // Beispielwerte der Tabelle bei 500 rpm: Tier I 12,984, Tier II 10,536 g/kWh
  near(E.noxFactor('ms', 1, 500), 12.984, 0.001, 'Tier I, 500 rpm');
  near(E.noxFactor('ms', 2, 500), 10.536, 0.001, 'Tier II, 500 rpm');
  assert.equal(E.noxFactor('hs', 2, 2100), 7.7, 'n ≥ 2.000 → Konstante');
  assert.equal(E.noxFactor('hs', 2, null), 7.7, 'ohne Drehzahl → Tabelle HSD');
  assert.equal(E.noxFactor('ms', 0, 750), 14.0, 'Tier 0 → Tabelle MSD');
  // MSD: SFC 175 statt 185 g/kWh (Baujahr ab 2001) → Kraftstoff Hauptmaschine × 175/185
  const hs = E.calcHourlyEmissions(example, 12, 0);
  const ms = E.calcHourlyEmissions({ ...example, engine_class: 'ms', rated_rpm: 750 }, 12, 0);
  near(ms.fuel_main_kg_h / hs.fuel_main_kg_h, 175 / 185, 1e-9, 'SFC-Verhältnis MSD/HSD');
  assert.equal(ms.engine_class, 'ms');
  assert.equal(ms.profile_estimated.engine_class, false);
  // dieselelektrisch mit mittelschnellen Gensets: Antrieb und Hotellast mit SFC 175
  const de = E.calcHourlyEmissions({ ...example, propulsion: 'diesel_electric', engine_class: 'ms' }, 0.3, 1);
  const deHs = E.calcHourlyEmissions({ ...example, propulsion: 'diesel_electric' }, 0.3, 1);
  near(de.fuel_kg_h / deHs.fuel_kg_h, 175 / 185, 1e-9, 'Gensets MSD');
});
