// Tests für public/js/climate.js: reproduziert Literaturwerte und die Prüfrechnung aus
// claude/recherche/erf_methodik_v2.md (Abschn. 6). Aufruf: node --test test/climate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../public/js/climate.js';

const near = (a, e, tol, msg) => assert.ok(Math.abs(a - e) <= tol, `${msg}: ${a} statt ${e} (±${tol})`);

test('AGWP CO2 reproduziert IPCC AR6 Tab. 7.SM.7', () => {
  near(C.agwpCO2(20) * 1e12, 0.0243, 0.0001, 'AGWP20');
  near(C.agwpCO2(100) * 1e12, 0.0895, 0.0001, 'AGWP100');
  near(C.agwpCO2(500) * 1e12, 0.314, 0.001, 'AGWP500');
});

test('GWP je Stoff (Standard: Skeie 2024, Holmes 2014)', () => {
  const g100 = C.gwp({ horizon: 100 }), g20 = C.gwp({ horizon: 20 });
  near(g100.n2o, 273, 1, 'N2O GWP100 (AR6: 273)');
  near(g100.so2, -94, 1, 'SO2 GWP100');
  near(g20.so2, -345, 2, 'SO2 GWP20');
  near(g100.nox, -13.4, 0.2, 'NOx GWP100 je kg NO2');
  near(g20.nox, -30.9, 0.3, 'NOx GWP20 je kg NO2');
});

test('NOx-Spanne reproduziert Fuglestvedt 2010 Tab. 4a mit AR6-CO2 (Größenordnung)', () => {
  const e = C.gwp({ horizon: 100, nox: 'eyring2007' }).nox / C.NOX_N_PER_NO2;
  near(e, -35, 3, 'Eyring 2007 GWP100 je kg N (Tab. 4a mit AR4-CO2: −36)');
});

// Prüfskript rechnete N2O mit SFC 200 g/kWh (0,17 t); hier SFC 185 (0,18 t) → je +4 t gegenüber 2.553 / 1.383 / 3.252
test('Beispielyacht 1.000 t MGO: CO2e 100 a ≈ 2.557 t, 20 a ≈ 1.387 t', () => {
  const row = { co2_kg_total: 3206e3, fuel_kg_total: 1000e3, sox_kg_total: 1955.06, nox_kg_total: 38500 };
  near(C.co2e(row, 'all', { horizon: 100 }) / 1e3, 2557, 3, 'CO2e100 alle Stoffe');
  near(C.co2e(row, 'all', { horizon: 20 }) / 1e3, 1387, 5, 'CO2e20 alle Stoffe');
  near(C.co2e(row, 'ghg', { horizon: 100 }) / 1e3, 3256, 3, 'CO2e100 nur Treibhausgase');
  // SO2-Schieberegler: obere Spanne −16,7 verdoppelt den SO2-Beitrag ungefähr
  const p = C.co2eParts(row, { horizon: 100, so2: -16.7 });
  near(p.so2 / 1e3, -184 * 16.7 / 8.4, 3, 'SO2-Anteil bei −16,7');
});

test('Nachwirkung: ERF am Ende eines Jahres gleichmäßiger Emission (Rekursion im Skript)', () => {
  const row = { co2_kg_total: 3206e3, fuel_kg_total: 1000e3, sox_kg_total: 1955.06, nox_kg_total: 38500 };
  const f = C.afterEffect(row, 1, 0);
  near(f.co2 * 1e9, 5.3, 0.1, 'CO2 nach 1 a (nW m-2)');
  near(f.so2 * 1e9, -16.4, 0.2, 'SO2 Gleichgewicht');
  const late = C.afterEffect(row, 1, 100);
  near(late.so2, 0, 1e-15, 'SO2 nach 100 a verschwunden');
  assert.ok(late.co2 > 0.4 * f.co2, 'CO2 bleibt großteils');
});
