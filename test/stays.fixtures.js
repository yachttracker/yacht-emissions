// Testfälle für die Liegezustände (lib/integrate.js). Feste Daten, damit die Erwartungen von Hand
// nachrechenbar sind: Hotellast 30 kg CO₂/h (Halt), Fahrt 500 kg/h. LIVE_SINCE 2026-11-12,
// "jetzt" 2027-01-31. Genutzt von test/stays.test.js.

const H = 3600000;
const NOW = '2027-01-31T00:00:00Z';
const PORT = { lat: 43.585, lon: 7.128 };     // Testhafen (Kreis 0,5 sm)
const YARD = { lat: 53.540, lon: 9.950 };     // Testwerft (Kreis 0,5 sm)
const ANCHOR = { lat: 43.300, lon: 6.900 };   // außerhalb aller Zonen
const SEA = { lat: 42.500, lon: 6.000 };

const ZONES = [
  { kind: 'port', name: 'Testhafen', lat: PORT.lat, lon: PORT.lon, radius_sm: 0.5 },
  { kind: 'yard', name: 'Testwerft', lat: YARD.lat, lon: YARD.lon, radius_sm: 0.5 },
];

const PARAMS = {
  maxGapHours: 7, maxGapHoursHistory: 1, stationaryMaxGapHours: 24, stationaryVKn: 2,
  stationaryDistSm: 0.3, yardMinHours: 72, silentMinDays: 30, maxBridgeDays: 0,
  liveSince: new Date('2026-11-12T00:00:00Z'),
};

const at = (iso) => new Date(iso).getTime();
const iso = (t) => new Date(t).toISOString();
// Halt-Punkte alle stepH Stunden von a bis b (einschließlich)
function every(a, b, stepH, pos, source = 'live') {
  const out = [];
  for (let t = at(a); t <= at(b); t += stepH * H) out.push({ ts: iso(t), ...pos, sog: 0, co2: 30, source });
  return out;
}
const pt = (ts, pos, sog, co2, source = 'live') => ({ ts, ...pos, sog, co2, source });
const day = (d) => d;   // Lesbarkeit

const DEC = { t0: '2026-12-01T00:00:00Z', t1: '2026-12-31T00:00:00Z' };   // 720 h

const SCENARIOS = [
  { id: 'S1', title: 'Hafen, AIS sendet (Antibes-Fall): ganzer Monat Hotelbetrieb',
    mmsi: '990000001', points: every('2026-12-01T00:00:00Z', '2026-12-31T00:00:00Z', 12, PORT),
    win: DEC, expect: { co2_kg_total: 21600, coverage_h: 720, coverage_layup_h: 0, coverage_yard_h: 0 } },

  { id: 'S2', title: 'Hafen, AIS seit 20.11. stumm (≥ 30 Tage, offen): Lay-up ab der letzten Meldung',
    mmsi: '990000002', points: [pt('2026-11-20T00:00:00Z', PORT, 0, 30)],
    win: DEC, expect: { co2_kg_total: 0, coverage_h: 720, coverage_layup_h: 720, coverage_layup_unconfirmed_h: 720 } },

  { id: 'S3', title: 'Hafen, 10 Tage Stille, danach wieder Meldungen am selben Ort: Hotelbetrieb',
    mmsi: '990000003',
    points: [...every('2026-12-01T00:00:00Z', '2026-12-05T00:00:00Z', 12, PORT),
             ...every('2026-12-15T00:00:00Z', '2026-12-31T00:00:00Z', 12, PORT)],
    win: DEC, expect: { co2_kg_total: 21600, coverage_h: 720, coverage_layup_h: 0 } },

  { id: 'S4', title: 'Hafen, 40 Tage Stille (geschlossen): Lay-up',
    mmsi: '990000004', points: [pt('2026-12-01T00:00:00Z', PORT, 0, 30), pt('2027-01-10T00:00:00Z', PORT, 0, 30)],
    win: DEC, expect: { co2_kg_total: 0, coverage_h: 720, coverage_layup_h: 720 } },

  { id: 'S5', title: 'Werft 5 Tage (AIS sendet): 0, danach Fahrt',
    mmsi: '990000005',
    points: [...every('2026-12-10T00:00:00Z', '2026-12-15T00:00:00Z', 12, YARD),
             pt('2026-12-15T12:00:00Z', SEA, 12, 500)],
    win: { t0: '2026-12-10T00:00:00Z', t1: '2026-12-16T00:00:00Z' },
    // 120 h Werft + 7 h nach dem letzten Werftpunkt (0) + 7 h Fahrt × 500
    expect: { co2_kg_total: 3500, coverage_h: 134, coverage_yard_h: 127 } },

  { id: 'S6', title: 'Werft-Kurzhalt 2 Tage: Hotelbetrieb',
    mmsi: '990000006',
    points: [...every('2026-12-10T00:00:00Z', '2026-12-12T00:00:00Z', 12, YARD),
             pt('2026-12-12T12:00:00Z', SEA, 12, 500)],
    win: { t0: '2026-12-10T00:00:00Z', t1: '2026-12-13T00:00:00Z' },
    // 48 h × 30 + 7 h × 30 + 7 h × 500
    expect: { co2_kg_total: 5150, coverage_h: 62, coverage_yard_h: 0 } },

  { id: 'S7', title: 'Anker, 3 Tage ohne Live-Meldung: nur 24 h überbrückt (AIS-Pflicht vor Anker)',
    mmsi: '990000007', points: [pt('2026-12-01T00:00:00Z', ANCHOR, 0, 30), pt('2026-12-04T00:00:00Z', ANCHOR, 0, 30)],
    win: { t0: '2026-12-01T00:00:00Z', t1: '2026-12-05T00:00:00Z' },
    expect: { co2_kg_total: 930, coverage_h: 31, coverage_bridged_h: 17 } },

  { id: 'S8', title: 'Historie 2025, Lücke geprüft (Tage ohne Positionsänderung): ganz überbrückt, Abfahrt am selben Ort',
    mmsi: '990000008',
    points: [pt('2025-06-01T10:00:00Z', ANCHOR, 0, 30, 'history'),
             pt('2025-06-05T10:00:00Z', ANCHOR, 8, 500, 'history'),
             pt('2025-06-05T10:30:00Z', SEA, 12, 500, 'history')],
    days: [['2025-06-01', 'done'], ['2025-06-02', 'empty'], ['2025-06-03', 'empty'], ['2025-06-04', 'empty'], ['2025-06-05', 'done']],
    win: { t0: '2025-06-01T00:00:00Z', t1: '2025-06-06T00:00:00Z' },
    // 96 h × 30 + 0,5 h × 500 + 1 h × 500
    expect: { co2_kg_total: 3630, coverage_h: 97.5 } },

  { id: 'S9', title: 'Historie 2025, Lücke nicht geprüft: wie bisher höchstens 24 h',
    mmsi: '990000009',
    points: [pt('2025-06-01T10:00:00Z', ANCHOR, 0, 30, 'history'),
             pt('2025-06-05T10:00:00Z', ANCHOR, 8, 500, 'history'),
             pt('2025-06-05T10:30:00Z', SEA, 12, 500, 'history')],
    days: [['2025-06-01', 'done'], ['2025-06-05', 'done']],
    win: { t0: '2025-06-01T00:00:00Z', t1: '2025-06-06T00:00:00Z' },
    expect: { co2_kg_total: 1470, coverage_h: 25.5 } },

  { id: 'S10', title: 'Alte Meldung (vor dem Live-Betrieb) im Hafen: keine Überbrückung über 14 Monate',
    mmsi: '990000010',
    points: [pt('2025-09-09T00:00:00Z', PORT, 0, 30),
             ...every('2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z', 12, PORT)],
    win: { t0: '2026-11-19T00:00:00Z', t1: '2026-11-21T00:00:00Z' },
    expect: { co2_kg_total: 720, coverage_h: 24, coverage_layup_h: 0 },
    alsoAbsentIn: { t0: '2025-10-01T00:00:00Z', t1: '2025-10-31T00:00:00Z' } },

  { id: 'S11', title: 'Belegtes Lay-up (Pause laid_up mit Quelle): 0 trotz sendendem AIS',
    mmsi: '990000011', imo: '9990011', since: '2026-12-01',
    points: every('2026-12-01T00:00:00Z', '2026-12-31T00:00:00Z', 12, ANCHOR),
    win: DEC, expect: { co2_kg_total: 0, coverage_h: 720, coverage_layup_h: 720, coverage_layup_unconfirmed_h: 0 } },

  { id: 'S12', title: 'Werft-Episode beginnt vor dem Fenster: 1-Tages-Fenster mitten im Refit = 0',
    mmsi: '990000012', points: every('2026-12-01T00:00:00Z', '2026-12-20T00:00:00Z', 12, YARD),
    win: { t0: '2026-12-10T00:00:00Z', t1: '2026-12-11T00:00:00Z' },
    expect: { co2_kg_total: 0, coverage_h: 24, coverage_yard_h: 24 } },
];

module.exports = { SCENARIOS, ZONES, PARAMS, NOW, day };
