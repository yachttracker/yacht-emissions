// ── Auswahl des Datenanbieters ──────────────────────────────────────────────
// AIS_PROVIDER = none (Standard) | myshiptracking | mock
// Neue Anbieter (z. B. Datalastic) brauchen nur fetchLive, fetchHistory und COSTS.
function getProvider() {
  const name = (process.env.AIS_PROVIDER || 'none').toLowerCase();
  if (name === 'none') return null;
  if (name === 'myshiptracking') return require('./myshiptracking');
  if (name === 'mock') {
    if (process.env.ALLOW_MOCK !== 'true') throw new Error('Mock-Anbieter nur mit ALLOW_MOCK=true');
    return require('./mock');
  }
  throw new Error(`Unbekannter AIS_PROVIDER: ${name}`);
}

module.exports = { getProvider };
