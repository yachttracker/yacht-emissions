// ── Auswahl des Datenanbieters ──────────────────────────────────────────────
// AIS_PROVIDER = none (Standard) | datalastic | myshiptracking | mock
// Ein Anbieter braucht fetchLive, fetchHistory und COSTS; optional fetchByImo (Identitätsabgleich)
// und HISTORY (Grenzen der Historie, z. B. Tage je Abfrage, ältestes Datum).
function getProvider() {
  const name = (process.env.AIS_PROVIDER || 'none').toLowerCase();
  if (name === 'none') return null;
  if (name === 'datalastic') return require('./datalastic');
  if (name === 'myshiptracking') return require('./myshiptracking');
  if (name === 'mock') {
    if (process.env.ALLOW_MOCK !== 'true') throw new Error('Mock-Anbieter nur mit ALLOW_MOCK=true');
    return require('./mock');
  }
  throw new Error(`Unbekannter AIS_PROVIDER: ${name}`);
}

module.exports = { getProvider };
