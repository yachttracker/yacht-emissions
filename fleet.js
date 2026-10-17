// ── FLOTTE (MMSI + Stammdaten) ──────────────────────────────────────────────
// Unverändert aus server.js (Stand 5c47ffc) ausgelagert, damit Server und
// Abruflogik dieselbe Liste nutzen. Eigentümer und Längen sind laut
// 00_projektstand noch neu zu belegen (ungeklärt).
const YACHTS = [
  { mmsi: '319225400', name: 'Koru',         owner: 'Jeff Bezos',                 length: 127, flag: '🇰🇾' },
  { mmsi: '538071886', name: 'Carinthia VII', owner: 'Porsche/Piëch-Familie',     length: 75,  flag: '🇲🇭' },
  { mmsi: '319318200', name: 'My Deep Blue', owner: 'unbestätigt',                 length: 134, flag: '🇰🇾' },
  { mmsi: '538072122', name: 'Launchpad',    owner: 'Mark Zuckerberg',            length: 118, flag: '🇲🇭' },
  { mmsi: '319205400', name: 'Boardwalk',    owner: 'Tilman Fertitta',            length: 77,  flag: '🇰🇾' },
  { mmsi: '538071476', name: 'Kismet',       owner: 'Shahid Khan',                length: 122, flag: '🇲🇭' },
  { mmsi: '319076700', name: 'Symphony',     owner: 'Bernard Arnault',            length: 101, flag: '🇰🇾' },
  { mmsi: '319306800', name: 'Moonrise',     owner: 'Undisclosed',                length: 100, flag: '🇰🇾' },
  { mmsi: '311001556', name: 'Emerald Kaia', owner: 'Emerald Cruises (kommerziell)', length: 142, flag: '🇧🇸' },
  { mmsi: '319032600', name: 'Musashi',      owner: 'Larry Ellison',              length: 88,  flag: '🇰🇾' },
];

const byMmsi = new Map(YACHTS.map(y => [y.mmsi, y]));

module.exports = { YACHTS, byMmsi };
