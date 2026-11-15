// ── Orte für die Liegezustände: Häfen und Werften (Regel Paul, 2026-11-15) ──────────
// data/ports.csv  – Häfen/Marinas: Halt dort = Hafen (Hotelbetrieb; schweigt das AIS lange → Lay-up)
// data/yards.csv  – Werften (Refit/Trockendock): Halt dort länger als STAY_YARD_MIN_HOURS = Werft (0)
// Ein Halt außerhalb aller Zonen gilt als Anker (Hotelbetrieb).
// Jede Zeile nur mit Quelle. Kreis um (lat, lon) mit radius_sm (Seemeilen).
// Leere Dateien sind erlaubt: dann ist jeder Halt "Anker" und die Rechnung bleibt wie bisher.

const fs = require('fs');
const path = require('path');

const FILES = { port: 'ports.csv', yard: 'yards.csv' };
const HEAD = ['name', 'lat', 'lon', 'radius_sm', 'source_url', 'note'];

function loadZoneCsv(file, kind) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const head = (lines.shift() || '').split(';').map(s => s.trim());
  if (HEAD.some((h, i) => head[i] !== h)) {
    throw new Error(`${path.basename(file)}: Kopfzeile muss ${HEAD.join(';')} sein`);
  }
  return lines.map((l, i) => {
    const c = l.split(';').map(s => s.trim());
    const r = Object.fromEntries(HEAD.map((h, j) => [h, c[j] ?? '']));
    const where = `${path.basename(file)} Zeile ${i + 2} (${r.name || '?'})`;
    const lat = Number(r.lat), lon = Number(r.lon), radius = Number(r.radius_sm);
    if (!r.name) throw new Error(`${where}: name fehlt`);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`${where}: lat ungültig`);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`${where}: lon ungültig`);
    if (!Number.isFinite(radius) || radius <= 0 || radius > 5) throw new Error(`${where}: radius_sm muss > 0 und ≤ 5 sein`);
    if (!/^https?:\/\//.test(r.source_url)) throw new Error(`${where}: source_url fehlt (nur mit Quelle)`);
    return { kind, name: r.name, lat, lon, radius_sm: radius, source_url: r.source_url };
  });
}

function loadZones(dir = path.join(__dirname, '..', 'data')) {
  return Object.entries(FILES).flatMap(([kind, f]) => loadZoneCsv(path.join(dir, f), kind));
}

module.exports = { loadZones, loadZoneCsv, FILES };
