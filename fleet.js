// ── FLOTTE (MMSI + Stammdaten) ──────────────────────────────────────────────
// Gemeinsam genutzt von Server, Abruflogik und Emissionsberechnung (emissions.js v3).
// Eigentümer stehen bewusst NICHT hier (öffentliches Repo, Entscheidung 2026-10-18):
// Sie werden mit Quelle und Status über die Admin-Seite in die Datenbank eingetragen.
//
// Stammdaten je Yacht in `facts`: { wert, status, quelle }.
//   status: 'sourced' (belegt, Quelle angegeben) | 'unverified' (ungeklärt/widersprüchlich) |
//           'assumption' (Annahme). Recherchestand 2026-10-30, Tiefe bewusst begrenzt
//           (Antriebsart, Leistung, Baujahr, GT, v_max; 03_daten_flotte).
// Für die Rechnung genutzt werden nur Werte mit Status 'sourced'; fehlende Felder ersetzt
// emissions.js durch Kategorie-Standardwerte (Annahme) und meldet das je Messpunkt.
// Achtung: Fachseiten (Superyacht Times, SuperYachtFan) sind Sekundärquellen; die Zuordnung
// MMSI ↔ Yacht ist nur dort sicher, wo sie ausdrücklich belegt ist (Status 'mmsi_match').

const SRC = {
  syt: name => `Superyacht Times, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  syf: name => `SuperYachtFan, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  wiki: 'Wikipedia, List of motor yachts by length (abgerufen 2026-10-30)',
  yb: 'YachtBuyer, The World\'s Biggest Yachts (abgerufen 2026-10-30)',
  research1015: 'Projektrecherche 2026-10-15 (03_daten_flotte), Superyacht Times',
};
const hp = v => Math.round(v * 0.7457); // 1 hp = 0,7457 kW

const S = (value, src) => ({ value, status: 'sourced', src });
const U = (value, src) => ({ value, status: 'unverified', src });

const YACHTS_RAW = [
  { mmsi: '319225400', name: 'Koru', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      length:      S(127.0, SRC.syt('Koru')),         // YachtBuyer: 125,82 m
      gt:          S(3493, `${SRC.syt('Koru')}; ${SRC.yb}`),
      build_year:  S(2023, SRC.syt('Koru')),
      propulsion:  S('sail_aux', `${SRC.syt('Koru')}: Segelyacht (Schoner), 2 Propeller`),
      mcr_kw:      S(2920, `${SRC.syt('Koru')}: 2 × MTU 16V 2000 M72 à 1.460 kW`),
      vmax_kn:     U(20.0, `${SRC.syt('Koru')} – unklar, ob unter Motor oder Segel`),
      draught_ref_m: S(5.02, SRC.syt('Koru')),
    } },
  { mmsi: '538071886', name: 'Carinthia VII', flag: '🇲🇭', mmsi_match: 'unverified',
    facts: {
      length:      S(97.2, `${SRC.syf('Carinthia VII')}; Wikipedia-Liste 98,0 m`),
      build_year:  S(2002, `${SRC.syf('Carinthia VII')}; ${SRC.wiki}`),
      propulsion:  U('diesel_mech', `${SRC.syf('Carinthia VII')}: 4 × MTU 1163, kein Hinweis auf E-Antrieb (Annahme dieselmechanisch)`),
      mcr_kw:      S(hp(4 * 10064), `${SRC.syf('Carinthia VII')}: 4 × MTU 1163 à 10.064 hp`),
      vmax_kn:     S(26, SRC.syf('Carinthia VII')),
      draught_ref_m: S(4.8, SRC.syf('Carinthia VII')),
    } },
  { mmsi: '319318200', name: 'My Deep Blue', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      length:      S(134.2, SRC.wiki),
      build_year:  U(2025, `${SRC.wiki}; SuperYachtFan nennt 2026`),
    } },
  { mmsi: '538072122', name: 'Launchpad', flag: '🇲🇭', mmsi_match: 'unverified',
    facts: {
      length:      S(118, SRC.wiki),
      build_year:  S(2024, `${SRC.wiki}; ${SRC.syt('Launchpad')}`),
      propulsion:  S('diesel_electric', `${SRC.research1015}: dieselelektrisch, 2 Propeller`),
      mcr_kw:      U(15816, `${SRC.research1015}: 4 × MTU 20V 4000 M93L = installierte Genset-Leistung, nicht Antriebsleistung`),
      vmax_kn:     S(20, `${SRC.syf('Launchpad')} („up to 20 knots“)`),
    } },
  { mmsi: '319205400', name: 'Boardwalk', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      // Zwei Yachten dieses Namens (Wikipedia-Liste): 76,5 m Feadship 2021 und 117 m Lürssen 2026.
      // Länge im bisherigen Code (77 m) passt zur Feadship → MMSI-Zuordnung prüfen.
      length:      U(76.5, `${SRC.wiki} (Feadship 2021)`),
      build_year:  U(2021, `${SRC.wiki} (Feadship 2021)`),
    } },
  { mmsi: '538071476', name: 'Kismet', flag: '🇲🇭', mmsi_match: 'unverified',
    facts: {
      length:      S(122.0, `${SRC.wiki}; ${SRC.syf('Kismet')}`),
      build_year:  S(2024, SRC.wiki),
    } },
  { mmsi: '319076700', name: 'Symphony', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      length:      S(101.5, SRC.wiki),
      build_year:  S(2015, `${SRC.wiki}; ${SRC.syf('Symphony')}`),
      propulsion:  U('hybrid', `${SRC.syf('Symphony')}: 4 × MTU 16V4000 M73, Hybrid mit Generatoren und Batterie – ob Bordnetz aus Antriebsdieseln, offen`),
      vmax_kn:     S(21, SRC.syf('Symphony')),
    } },
  { mmsi: '319306800', name: 'Moonrise', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      // Konflikt: VesselFinder (Recherche Juni) nennt zu dieser MMSI IMO 9949869, Bj. 2025;
      // Superyacht Times/Wikipedia beschreiben Feadship Moonrise 2020 → Zuordnung ungeklärt.
      length:      S(99.9, SRC.syt('Moonrise')),
      gt:          U(3945, SRC.syt('Moonrise')),
      build_year:  U(2020, `${SRC.syt('Moonrise')}; VesselFinder nennt 2025`),
      propulsion:  U('diesel_mech', `${SRC.syt('Moonrise')}: 2 × MTU 20V 4000 M73L, 2 Propeller`),
      mcr_kw:      U(7178, `${SRC.syt('Moonrise')}: 2 × 3.589 kW`),
      vmax_kn:     U(18.5, SRC.syt('Moonrise')),
      draught_ref_m: U(4.2, SRC.syt('Moonrise')),
    } },
  { mmsi: '311001556', name: 'Emerald Kaia', flag: '🇧🇸', mmsi_match: 'unverified', commercial: true, // Entfernen offen
    facts: { length: U(142, 'Projektliste, ungeprüft') } },
  { mmsi: '319032600', name: 'Musashi', flag: '🇰🇾', mmsi_match: 'unverified',
    facts: {
      length:      S(87.8, SRC.wiki),
      build_year:  S(2011, `${SRC.wiki}; SuperYachtFan nennt 2010`),
      vmax_kn:     S(21, SRC.syf('Musashi')),
    } },
];

// Flache Felder für die Rechnung: nur belegte Werte; Länge immer (auch ungeklärt) als Größenhinweis
function flatten(y) {
  const out = { mmsi: y.mmsi, name: y.name, flag: y.flag, facts: y.facts, mmsi_match: y.mmsi_match };
  if (y.commercial) out.commercial = true;
  for (const [k, f] of Object.entries(y.facts || {})) {
    if (k === 'length' || f.status === 'sourced') out[k] = f.value;
  }
  return out;
}

const YACHTS = YACHTS_RAW.map(flatten);
const byMmsi = new Map(YACHTS.map(y => [y.mmsi, y]));

module.exports = { YACHTS, byMmsi };
