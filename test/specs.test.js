// Prüfskript für data/specs.csv (Stammdaten-Steckbriefe, Regeln R0–R6 vom 2026-11-01).
// Aufruf: node --test test/specs.test.js
// Prüft: gleiche IMO-Menge wie data/fleet.csv, gültige Werte und Status, Einheiten/Plausibilität der
// Leistung, Obergrenze ≥ Bestwert, Motorklasse passend zur Nenndrehzahl (IMO4 S. 49), dieselelektrisch mit
// Genset- bzw. E-Motor-Angabe, und dass Indizien in die Rechnung fließen (R0).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFleetCsv } = require('../fleet');
const path = require('path');

const specs = loadFleetCsv(path.join(__dirname, '..', 'data', 'specs.csv'));
const fleet = loadFleetCsv();
const STATUS = new Set(['sourced', 'indication', 'unverified']);
const PROPULSION = new Set(['diesel_mech', 'diesel_electric', 'codag', 'sail_aux', 'hybrid']);
const num = v => (v === '' ? null : Number(v));

test('gleiche Yachten wie data/fleet.csv, keine doppelte IMO', () => {
  const s = specs.map(r => r.imo), f = new Set(fleet.map(r => r.imo));
  assert.equal(new Set(s).size, s.length, 'doppelte IMO in specs.csv');
  assert.deepEqual([...s].filter(i => !f.has(i)), [], 'IMO nur in specs.csv');
  assert.deepEqual([...f].filter(i => !s.includes(i)), [], 'IMO fehlt in specs.csv');
  const name = new Map(fleet.map(r => [r.imo, r.name.split(' ')[0].toLowerCase()]));
  for (const r of specs) assert.equal(r.name.split(' ')[0].toLowerCase(), name.get(r.imo), `Name passt nicht zur IMO ${r.imo}`);
});

test('Werte und Status gültig', () => {
  for (const r of specs) {
    const id = `${r.name} (${r.imo})`;
    if (r.propulsion) {
      assert.ok(PROPULSION.has(r.propulsion), `${id}: Antriebsart ${r.propulsion}`);
      assert.ok(STATUS.has(r.propulsion_status), `${id}: propulsion_status`);
    }
    if (r.mcr_kw) assert.ok(STATUS.has(r.mcr_status), `${id}: mcr_status`);
    if (r.vmax_kn) assert.ok(STATUS.has(r.vmax_status), `${id}: vmax_status`);
    if (r.rated_rpm || r.rpm_status) assert.ok(STATUS.has(r.rpm_status), `${id}: rpm_status`);
    if (r.engine_class) assert.ok(['hs', 'ms', 'ss'].includes(r.engine_class), `${id}: engine_class`);
    if (r.mcr_kw) assert.ok(r.mcr_basis, `${id}: Leistung ohne Begründung (mcr_basis)`);
  }
});

test('Leistung plausibel (kW, nicht hp oder W), Obergrenze ≥ Bestwert', () => {
  const len = new Map(fleet.map(r => [r.imo, Number(r.length_m)]));
  for (const r of specs) {
    const kw = num(r.mcr_kw), up = num(r.mcr_upper_kw), id = `${r.name} (${r.imo})`;
    if (kw == null) continue;
    assert.ok(Number.isInteger(kw), `${id}: kW ganzzahlig`);
    // Annahme: Yachten 60–200 m liegen zwischen 1 und 80 MW (grobe Einheitenprüfung, keine Quelle)
    assert.ok(kw >= 1000 && kw <= 80000, `${id}: ${kw} kW außerhalb 1–80 MW`);
    // spezifische Leistung je Meter: fängt Tausenderfehler ab (Annahme 10–500 kW/m)
    const perM = kw / len.get(r.imo);
    assert.ok(perM >= 10 && perM <= 500, `${id}: ${perM.toFixed(0)} kW/m unplausibel`);
    if (up != null) assert.ok(up >= kw, `${id}: Obergrenze ${up} < Bestwert ${kw}`);
  }
});

test('Motorklasse passt zur Nenndrehzahl (IMO4 S. 49)', () => {
  for (const r of specs) {
    const n = num(r.rated_rpm);
    if (n == null || !r.engine_class) continue;
    const expected = n <= 300 ? 'ss' : n <= 900 ? 'ms' : 'hs';
    assert.equal(r.engine_class, expected, `${r.name}: ${n} rpm → ${expected}, eingetragen ${r.engine_class}`);
  }
});

test('dieselelektrisch: Leistungsbasis genannt (E-Motoren oder Genset-Summe als Obergrenze, R3)', () => {
  for (const r of specs.filter(x => x.propulsion === 'diesel_electric')) {
    assert.ok(/E-Fahrmotor|Genset-Summe/.test(r.mcr_basis), `${r.name}: Basis „${r.mcr_basis}“`);
    if (/Genset-Summe/.test(r.mcr_basis)) assert.ok(num(r.mcr_upper_kw) >= num(r.mcr_kw), `${r.name}: Genset-Summe als Obergrenze eintragen`);
  }
});

test('R0: Indizien fließen in die Rechnung, ungeklärte nicht', () => {
  const { YACHTS } = require('../fleet');
  const byImo = new Map(YACHTS.map(y => [y.imo, y]));
  for (const r of specs) {
    const y = byImo.get(r.imo);
    if (r.mcr_kw && r.mcr_status !== 'unverified') assert.equal(y.mcr_kw, Number(r.mcr_kw), `${r.name}: mcr_kw`);
    if (r.propulsion && r.propulsion_status === 'unverified') assert.equal(y.propulsion, undefined, `${r.name}: ungeklärte Antriebsart darf nicht rechnen`);
    if (r.propulsion && r.propulsion_status !== 'unverified') assert.equal(y.propulsion, r.propulsion, `${r.name}: propulsion`);
  }
});
