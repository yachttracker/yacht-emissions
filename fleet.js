// ── FLOTTE (MMSI + Stammdaten) ──────────────────────────────────────────────
// Gemeinsam genutzt von Server, Abruflogik und Emissionsberechnung (emissions.js v3).
// Eigentümer stehen bewusst NICHT hier (öffentliches Repo, Entscheidung 2026-10-18):
// Sie werden mit Quelle und Status über die Admin-Seite in die Datenbank eingetragen.
//
// Flottenumfang (Entscheidung 2026-10-30): alle Yachten mit MMSI aus der Vereinigung der Top 110
// nach Länge und der Top 100 nach GT → data/fleet.csv (108 Yachten). Staats-/Königshausyachten sind
// enthalten (segment 'state_royal', im Dashboard filterbar); kommerzielle Charter-/Passagierschiffe,
// Marine-/Schulschiffe, Begleitschiffe und Yachten außerhalb der Größten sind ausgeschlossen.
// Liste mit Begründungen: Projektdokument recherche/flotte_top100.md.
//
// Stammdaten je Yacht in `facts`: { value, status, src }.
//   status: 'sourced' (belegt, Quelle angegeben) | 'unverified' (ungeklärt/widersprüchlich) |
//           'assumption' (Annahme).
// Grundwerte (Länge, GT, Baujahr) stammen aus der Kandidatenliste (VesselFinder, Sekundärquelle).
// Tiefer recherchierte Werte (DETAILS unten, nach IMO) haben Vorrang.
// Für die Rechnung genutzt werden nur Werte mit Status 'sourced'; fehlende Felder ersetzt
// emissions.js durch Kategorie-Standardwerte (Annahme) und meldet das je Messpunkt.

const fs = require('fs');
const path = require('path');

const SRC = {
  vf: 'VesselFinder, Schiffsseite nach IMO (abgerufen 2026-10-30)',
  syt: name => `Superyacht Times, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  syf: name => `SuperYachtFan, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  wiki: 'Wikipedia, List of motor yachts by length (abgerufen 2026-10-30)',
  wikiSail: 'Wikipedia, List of large sailing yachts (abgerufen 2026-10-30)',
  yb: 'YachtBuyer, The World\'s Biggest Yachts (abgerufen 2026-10-30)',
  research1015: 'Projektrecherche 2026-10-15 (03_daten_flotte), Superyacht Times',
  prop1015: 'Projektrecherche Antriebsart 2026-10-15 (03_daten_flotte; Superyacht Times, ergänzt Wikipedia/SuperYachtFan)',
  azzam: 'Hansa 03/2014; BOAT International; YachtHarbour (03_daten_flotte)',
};
const hp = v => Math.round(v * 0.7457); // 1 hp = 0,7457 kW

const S = (value, src) => ({ value, status: 'sourced', src });
const U = (value, src) => ({ value, status: 'unverified', src });

// ── Tiefer recherchierte Stammdaten, Schlüssel = IMO ─────────────────────────
const DE_SOURCED = { propulsion: S('diesel_electric', `${SRC.prop1015}: dieselelektrisch belegt`) };
const DE_INDICATION = { propulsion: U('diesel_electric', `${SRC.prop1015}: Indiz (Pods bzw. mehr Motoren als Propeller), nicht belegt`) };
const DM_PROBABLE = { propulsion: U('diesel_mech', `${SRC.prop1015}: „Diesel“, kein Hinweis auf E-Antrieb – vermutlich dieselmechanisch`) };
const SAIL = { propulsion: S('sail_aux', `${SRC.wikiSail}: Segelyacht`) };

const DETAILS = {
  // Koru
  9857298: {
    length:      S(127.0, SRC.syt('Koru')),         // YachtBuyer: 125,82 m; VesselFinder 125 m
    gt:          S(3493, `${SRC.syt('Koru')}; ${SRC.yb}`),
    build_year:  S(2023, SRC.syt('Koru')),
    propulsion:  S('sail_aux', `${SRC.syt('Koru')}: Segelyacht (Schoner), 2 Propeller`),
    mcr_kw:      S(2920, `${SRC.syt('Koru')}: 2 × MTU 16V 2000 M72 à 1.460 kW`),
    vmax_kn:     U(20.0, `${SRC.syt('Koru')} – unklar, ob unter Motor oder Segel`),
    draught_ref_m: S(5.02, SRC.syt('Koru')),
  },
  // Carinthia VII
  8994001: {
    length:      S(97.2, `${SRC.syf('Carinthia VII')}; Wikipedia-Liste 98,0 m`),
    build_year:  S(2002, `${SRC.syf('Carinthia VII')}; ${SRC.wiki}`),
    propulsion:  U('diesel_mech', `${SRC.syf('Carinthia VII')}: 4 × MTU 1163, kein Hinweis auf E-Antrieb (Annahme dieselmechanisch)`),
    mcr_kw:      S(hp(4 * 10064), `${SRC.syf('Carinthia VII')}: 4 × MTU 1163 à 10.064 hp`),
    vmax_kn:     S(26, SRC.syf('Carinthia VII')),
    draught_ref_m: S(4.8, SRC.syf('Carinthia VII')),
  },
  // My Deep Blue
  9950686: {
    length:      S(134.2, SRC.wiki),
    build_year:  U(2025, `${SRC.wiki}; SuperYachtFan und VesselFinder nennen 2026`),
  },
  // Launchpad
  9857511: {
    length:      S(118, SRC.wiki),
    build_year:  S(2024, `${SRC.wiki}; ${SRC.syt('Launchpad')}`),
    propulsion:  S('diesel_electric', `${SRC.research1015}: dieselelektrisch, 2 Propeller`),
    mcr_kw:      U(15816, `${SRC.research1015}: 4 × MTU 20V 4000 M93L = installierte Genset-Leistung, nicht Antriebsleistung`),
    vmax_kn:     S(20, `${SRC.syf('Launchpad')} („up to 20 knots“)`),
  },
  // Kismet
  9881627: {
    length:      S(122.0, `${SRC.wiki}; ${SRC.syf('Kismet')}`),
    build_year:  S(2024, SRC.wiki),
  },
  // Symphony
  1012098: {
    length:      S(101.5, SRC.wiki),
    build_year:  S(2015, `${SRC.wiki}; ${SRC.syf('Symphony')}`),
    propulsion:  U('hybrid', `${SRC.syf('Symphony')}: 4 × MTU 16V4000 M73, Hybrid mit Generatoren und Batterie – ob Bordnetz aus Antriebsdieseln, offen`),
    vmax_kn:     S(21, SRC.syf('Symphony')),
  },
  // Reverie (ex Moonrise, Feadship 2020). Die Superyacht-Times-Seite „Moonrise“ beschreibt die Feadship 2020;
  // Zuordnung zu IMO 9816232 über GT 3.945, Länge ≈ 100 m und Baujahr 2020 (stimmt mit VesselFinder überein).
  9816232: {
    length:      S(99.9, `${SRC.syt('Moonrise')} (Feadship 2020, heute Reverie)`),
    gt:          S(3945, `${SRC.syt('Moonrise')}; ${SRC.vf}`),
    build_year:  S(2020, `${SRC.syt('Moonrise')}; ${SRC.vf}`),
    propulsion:  S('diesel_mech', `${SRC.syt('Moonrise')}: 2 × MTU 20V 4000 M73L, 2 Propeller`),
    mcr_kw:      S(7178, `${SRC.syt('Moonrise')}: 2 × 3.589 kW`),
    vmax_kn:     S(18.5, SRC.syt('Moonrise')),
    draught_ref_m: S(4.2, SRC.syt('Moonrise')),
  },
  // Azzam (CODAG). Aufteilung Diesel/Gasturbine widersprüchlich → diesel_kw nur ungeklärt.
  9693367: {
    length:      S(180, 'Hansa 03/2014 (03_daten_flotte)'),
    gt:          S(13136, 'Wikipedia; YachtHarbour (03_daten_flotte)'),
    build_year:  S(2013, 'Hansa 03/2014; Wikipedia'),
    propulsion:  S('codag', `${SRC.azzam}: 2 Gasturbinen + 2 Diesel, 4 Waterjets`),
    mcr_kw:      S(hp(94000), `${SRC.azzam}: 94.000 hp ≈ 70 MW`),
    vmax_kn:     S(30, 'Hansa 03/2014: „über 30 kn“ (Untergrenze; Wikipedia > 32, BOAT International 33 kn)'),
    diesel_kw:   U(18000, 'BOAT International 2 × 9 MW; widersprüchlich zu YachtHarbour/Wikipedia'),
    draught_ref_m: S(4.3, 'Hansa 03/2014'),
  },
  // Al Said: 2 Haupt-MTU 20V 8000 + 5 MTU 16V 4000 Gensets → dieselmechanisch mit separaten Generatoren
  9463774: { propulsion: S('diesel_mech', `${SRC.prop1015}: 2 Hauptmaschinen MTU 20V 8000 + 5 Gensets MTU 16V 4000`) },
  // Zoza (ex Luminosity): dieselelektrisch 6 × CAT C32 (Superyacht Times, 02_methodik Referenzyachten)
  9754032: { propulsion: S('diesel_electric', `${SRC.syt('Zoza')}: dieselelektrisch, 6 × CAT C32`) },
  // Dieselelektrisch belegt (Recherche 2026-10-15)
  9661792: DE_SOURCED,                       // Dilbar
  9551454: { propulsion: S('diesel_electric', `${SRC.prop1015}: dieselelektrisch, nur SuperYachtFan`) }, // A+
  1012933: DE_SOURCED,                       // Opera
  9907196: { propulsion: S('diesel_electric', `${SRC.prop1015}: „diesel-electric hybrid“ (Wikipedia, SuperYachtFan)`) }, // Dragonfly
  9819820: DE_SOURCED,                       // Solaris
  1009223: DE_SOURCED,                       // Al Mirqab
  9648788: DE_SOURCED,                       // Golden Odyssey
  9899650: DE_SOURCED,                       // Breakthrough
  9865075: DE_SOURCED,                       // Liva O
  9770270: DE_SOURCED,                       // Multiverse
  // Indiz dieselelektrisch
  1009613: DE_INDICATION,                    // Eclipse
  1011850: DE_INDICATION,                    // Ocean Victory
  1007213: DE_INDICATION,                    // Octopus
  9044619: DE_INDICATION,                    // Maryah
  // Widersprüchlich
  9862231: { propulsion: U('diesel_electric', `${SRC.prop1015}: Wikipedia „diesel-electric hybrid“, Superyacht Times „Diesel“ – widersprüchlich`) }, // Blue
  8652201: { propulsion: U('diesel_mech', `${SRC.prop1015}: ex-Fregatte (Gasturbinen), Superyacht Times 2 × MTU-Diesel – vermutlich umgerüstet`) }, // Yas
  // Vermutlich dieselmechanisch
  9714460: DM_PROBABLE, 1006324: DM_PROBABLE, 1003308: DM_PROBABLE, 9853785: DM_PROBABLE, 9809980: DM_PROBABLE,
  1007043: DM_PROBABLE, 9865087: DM_PROBABLE, 8982307: DM_PROBABLE, 9785108: DM_PROBABLE, 9562805: DM_PROBABLE,
  9772929: DM_PROBABLE, 6603012: DM_PROBABLE, 9967847: DM_PROBABLE, 1009340: DM_PROBABLE, 8907216: DM_PROBABLE,
  1000667: DM_PROBABLE, 1000320: DM_PROBABLE, 8977273: DM_PROBABLE, 1006829: DM_PROBABLE,
  // Segelyachten
  1012141: SAIL,                             // Sailing Yacht A
  1012490: SAIL,                             // Black Pearl
  9377456: SAIL,                             // Eos
  9384552: SAIL,                             // Maltese Falcon
};

// ── Flagge aus der MMSI (Maritime Identification Digits, ITU) ──────────────
// Annahme: Die MID entspricht dem aktuellen Flaggenstaat (MMSI kann nach Umflaggung veralten).
const MID = {
  211: 'DE', 215: 'MT', 229: 'MT', 235: 'GB', 248: 'MT', 249: 'MT', 271: 'TR', 273: 'RU',
  309: 'BS', 310: 'BM', 311: 'BS', 319: 'KY', 368: 'US', 376: 'VC', 403: 'SA', 461: 'OM',
  466: 'QA', 470: 'AE', 511: 'PW', 518: 'CK', 525: 'ID', 533: 'MY', 538: 'MH', 631: 'GQ', 667: 'SL',
};
const flagEmoji = iso => iso ? [...iso].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('') : null;

// ── Flottenliste laden (data/fleet.csv) ─────────────────────────────────────
function loadFleetCsv(file = path.join(__dirname, 'data', 'fleet.csv')) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = lines.shift().split(';');
  return lines.map(l => {
    const c = l.split(';');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}
const num = v => (v === '' || v === undefined ? null : Number(v));

function buildYacht(row) {
  const facts = {};
  if (num(row.length_m) != null) facts.length = S(num(row.length_m), SRC.vf);
  if (num(row.gt) != null) facts.gt = S(num(row.gt), SRC.vf);
  if (num(row.build_year) != null) facts.build_year = S(num(row.build_year), SRC.vf);
  Object.assign(facts, DETAILS[row.imo] || {});
  return {
    imo: row.imo, mmsi: row.mmsi, name: row.name,
    flag: flagEmoji(MID[row.mmsi.slice(0, 3)]),
    segment: row.segment || 'private',
    rank_gt: num(row.rank_gt), rank_length: num(row.rank_length),
    // MMSI per IMO über VesselFinder/MaritimeOptima (Sekundärquelle); 'conflict' = zwei Nummern im Umlauf
    mmsi_match: row.mmsi_status === 'sourced' ? 'sourced' : 'unverified',
    mmsi_status: row.mmsi_status, note: row.note || null,
    facts,
  };
}

const YACHTS_RAW = loadFleetCsv().map(buildYacht);

// Flache Felder für die Rechnung: nur belegte Werte; Länge immer (auch ungeklärt) als Größenhinweis
function flatten(y) {
  const { facts, ...base } = y;
  const out = { ...base, facts };
  for (const [k, f] of Object.entries(facts || {})) {
    if (k === 'length' || f.status === 'sourced') out[k] = f.value;
  }
  return out;
}

const YACHTS = YACHTS_RAW.map(flatten);
const byMmsi = new Map(YACHTS.map(y => [y.mmsi, y]));

if (byMmsi.size !== YACHTS.length) throw new Error('fleet.js: doppelte MMSI in data/fleet.csv');

module.exports = { YACHTS, byMmsi, loadFleetCsv };
