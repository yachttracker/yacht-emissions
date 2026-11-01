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
//   status: 'sourced' (belegt, Quelle angegeben) | 'indication' (Indiz) |
//           'unverified' (ungeklärt/widersprüchlich) | 'assumption' (Annahme).
// Grundwerte (Länge, GT, Baujahr) stammen aus der Kandidatenliste (VesselFinder, Sekundärquelle).
// Tiefer recherchierte Werte (DETAILS unten, nach IMO) haben Vorrang.
// Für die Rechnung genutzt werden Werte mit Status 'sourced' und 'indication' (Regel R0, 2026-11-01);
// fehlende Felder ersetzt emissions.js durch Kategorie-Standardwerte (Annahme) und meldet das je Messpunkt.

const fs = require('fs');
const path = require('path');

const SRC = {
  vf: 'VesselFinder, Schiffsseite nach IMO (abgerufen 2026-10-30)',
  syt: name => `Superyacht Times, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  syf: name => `SuperYachtFan, Yachtseite „${name}“ (abgerufen 2026-10-30)`,
  wiki: 'Wikipedia, List of motor yachts by length (abgerufen 2026-10-30)',
  yb: 'YachtBuyer, The World\'s Biggest Yachts (abgerufen 2026-10-30)',
};

const S = (value, src) => ({ value, status: 'sourced', src });
const U = (value, src) => ({ value, status: 'unverified', src });

// ── Tiefer recherchierte Stammdaten, Schlüssel = IMO ─────────────────────────
// Nur noch Größe, Baujahr, Bezugstiefgang und CODAG-Aufteilung. Antriebsart, Leistung (MCR),
// Motorklasse/Drehzahl und v_max kommen seit 2026-11-01 aus data/specs.csv (Steckbriefe, Regeln R0–R6).
const DETAILS = {
  // Koru
  9857298: {
    length:      S(127.0, SRC.syt('Koru')),         // YachtBuyer: 125,82 m; VesselFinder 125 m
    gt:          S(3493, `${SRC.syt('Koru')}; ${SRC.yb}`),
    build_year:  S(2023, SRC.syt('Koru')),
    draught_ref_m: S(5.02, SRC.syt('Koru')),
  },
  // Carinthia VII
  8994001: {
    length:      S(97.2, `${SRC.syf('Carinthia VII')}; Wikipedia-Liste 98,0 m`),
    build_year:  S(2002, `${SRC.syf('Carinthia VII')}; ${SRC.wiki}`),
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
  },
  // Reverie (ex Moonrise, Feadship 2020). Die Superyacht-Times-Seite „Moonrise“ beschreibt die Feadship 2020;
  // Zuordnung zu IMO 9816232 über GT 3.945, Länge ≈ 100 m und Baujahr 2020 (stimmt mit VesselFinder überein).
  9816232: {
    length:      S(99.9, `${SRC.syt('Moonrise')} (Feadship 2020, heute Reverie)`),
    gt:          S(3945, `${SRC.syt('Moonrise')}; ${SRC.vf}`),
    build_year:  S(2020, `${SRC.syt('Moonrise')}; ${SRC.vf}`),
    draught_ref_m: S(4.2, SRC.syt('Moonrise')),
  },
  // Azzam (CODAG). Aufteilung Diesel/Gasturbine widersprüchlich → diesel_kw nur ungeklärt.
  9693367: {
    length:      S(180, 'Hansa 03/2014 (03_daten_flotte)'),
    gt:          S(13136, 'Wikipedia; YachtHarbour (03_daten_flotte)'),
    build_year:  S(2013, 'Hansa 03/2014; Wikipedia'),
    diesel_kw:   U(18000, 'BOAT International 2 × 9 MW; widersprüchlich zu YachtHarbour/Wikipedia'),
    draught_ref_m: S(4.3, 'Hansa 03/2014'),
  },
};

// ── Technische Stammdaten aus data/specs.csv (Steckbriefe 2026-11-01) ─────────
// Status-Werte der Datei: sourced (belegt) | indication (Indiz) | unverified (ungeklärt).
// Regel R0 (Paul, 2026-11-01): belegt > Indiz > Standardwert – Indizien fließen in die Rechnung.
const SPEC_SRC = 'Steckbrief 2026-11-01 (Artefakt „Yacht-Steckbriefe“, Einzelquellen dort)';
const SPEC_STATUS = new Set(['sourced', 'indication', 'unverified']);

function loadSpecs(file = path.join(__dirname, 'data', 'specs.csv')) {
  if (!fs.existsSync(file)) return new Map();
  const rows = loadFleetCsv(file);
  const out = new Map();
  for (const r of rows) {
    const f = {};
    const put = (key, value, status, basis) => {
      if (value === null || value === '' || Number.isNaN(value)) return;
      if (!SPEC_STATUS.has(status)) throw new Error(`specs.csv: Status „${status}“ für ${key} (IMO ${r.imo}) ungültig`);
      f[key] = { value, status, src: basis ? `${SPEC_SRC}: ${basis}` : SPEC_SRC };
    };
    put('propulsion', r.propulsion, r.propulsion_status);
    put('mcr_kw', num(r.mcr_kw), r.mcr_status, r.mcr_basis);
    put('mcr_upper_kw', num(r.mcr_upper_kw), r.mcr_status, r.mcr_basis);
    put('rated_rpm', num(r.rated_rpm), r.rpm_status || 'indication', r.engine);
    if (r.engine_class) put('engine_class', r.engine_class, r.rpm_status || 'indication', r.engine);
    put('vmax_kn', num(r.vmax_kn), r.vmax_status);
    if (r.engine) f.engine = { value: r.engine, status: 'indication', src: SPEC_SRC };
    out.set(r.imo, f);
  }
  return out;
}

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
  // Detailwerte ergänzen die CSV; ein nicht belegter Detailwert überschreibt keinen belegten
  // CSV-Wert (Prüfbericht H6, My Deep Blue: Baujahr 2026 belegt vs. 2025 ungeprüft).
  for (const [k, f] of Object.entries(DETAILS[row.imo] || {})) {
    if (facts[k]?.status === 'sourced' && f.status !== 'sourced') continue;
    facts[k] = f;
  }
  // Steckbrief-Werte (data/specs.csv) sind die kuratierte Entscheidung je Yacht und gelten für ihre Felder.
  Object.assign(facts, SPECS.get(row.imo) || {});
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

const SPECS = loadSpecs();
const YACHTS_RAW = loadFleetCsv().map(buildYacht);

// Flache Felder für die Rechnung: belegte Werte und Indizien (R0); Länge immer (auch ungeklärt) als Größenhinweis
function flatten(y) {
  const { facts, ...base } = y;
  const out = { ...base, facts };
  for (const [k, f] of Object.entries(facts || {})) {
    if (k === 'length' || f.status === 'sourced' || f.status === 'indication') out[k] = f.value;
  }
  return out;
}

const YACHTS = YACHTS_RAW.map(flatten);
const byMmsi = new Map(YACHTS.map(y => [y.mmsi, y]));

if (byMmsi.size !== YACHTS.length) throw new Error('fleet.js: doppelte MMSI in data/fleet.csv');

module.exports = { YACHTS, byMmsi, loadFleetCsv, loadSpecs };
