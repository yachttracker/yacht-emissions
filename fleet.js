// ── FLOTTE (MMSI + Stammdaten) ──────────────────────────────────────────────
// Gemeinsam genutzt von Server und Abruflogik. Längen sind ungeprüfte Näherungen
// (03_daten_flotte, ungeklärt).
// Eigentümer stehen bewusst NICHT hier (öffentliches Repo, Entscheidung 2026-10-18):
// Sie werden mit Quelle und Status über die Admin-Seite in die Datenbank eingetragen
// (Tabellen owners / vessel_owner, lib/owners.js). Die früher hier eingetragenen
// Zuordnungen waren ungeprüft und wurden nicht übernommen.
const YACHTS = [
  { mmsi: '319225400', name: 'Koru',          length: 127, flag: '🇰🇾' },
  { mmsi: '538071886', name: 'Carinthia VII', length: 75,  flag: '🇲🇭' },
  { mmsi: '319318200', name: 'My Deep Blue',  length: 134, flag: '🇰🇾' },
  { mmsi: '538072122', name: 'Launchpad',     length: 118, flag: '🇲🇭' },
  { mmsi: '319205400', name: 'Boardwalk',     length: 77,  flag: '🇰🇾' },
  { mmsi: '538071476', name: 'Kismet',        length: 122, flag: '🇲🇭' },
  { mmsi: '319076700', name: 'Symphony',      length: 101, flag: '🇰🇾' },
  { mmsi: '319306800', name: 'Moonrise',      length: 100, flag: '🇰🇾' },
  { mmsi: '311001556', name: 'Emerald Kaia',  length: 142, flag: '🇧🇸' },   // kommerziell, Entfernen offen
  { mmsi: '319032600', name: 'Musashi',       length: 88,  flag: '🇰🇾' },
];

const byMmsi = new Map(YACHTS.map(y => [y.mmsi, y]));

module.exports = { YACHTS, byMmsi };
