const WebSocket = require('ws');

let lastCoverageResult = { status: 'not run yet' };

function runCoverageTest() {
  const apiKey = process.env.AISSTREAM_API_KEY;

  if (!apiKey) {
    lastCoverageResult = { status: 'error', message: 'AISSTREAM_API_KEY nicht gesetzt' };
    return;
  }

  lastCoverageResult = { status: 'connecting', startedAt: new Date().toISOString() };
  console.log('[COVERAGE-TEST] Verbindung wird aufgebaut (Rotterdam, ohne MMSI-Filter)...');

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  // Bounding Box rund um den Hafen von Rotterdam (sehr stark befahren)
  const rotterdamBox = [[[51.85, 3.95], [52.05, 4.55]]];

  let messageCount = 0;
  const samples = [];

  ws.on('open', () => {
    console.log('[COVERAGE-TEST] WebSocket OPEN');
    lastCoverageResult = { status: 'connected', connectedAt: new Date().toISOString() };

    const subscriptionMessage = {
      APIKey: apiKey,
      BoundingBoxes: rotterdamBox
      // Kein FiltersShipMMSI -> alle Schiffe in der Box
    };

    ws.send(JSON.stringify(subscriptionMessage));
    console.log('[COVERAGE-TEST] Subscription gesendet (Rotterdam Box, kein Filter)');
  });

  ws.on('message', (data) => {
    messageCount++;
    const parsed = JSON.parse(data.toString());

    if (parsed.MessageType === 'PositionReport' && samples.length < 5) {
      samples.push({
        mmsi: parsed.MetaData?.MMSI,
        shipName: parsed.MetaData?.ShipName,
        lat: parsed.Message?.PositionReport?.Latitude,
        lon: parsed.Message?.PositionReport?.Longitude
      });
    }

    lastCoverageResult = {
      status: 'receiving_data',
      messageCount,
      lastMessageAt: new Date().toISOString(),
      samples
    };
  });

  ws.on('error', (err) => {
    console.error('[COVERAGE-TEST] ERROR:', err.message);
    lastCoverageResult = { status: 'error', message: err.message };
  });

  ws.on('close', (code, reason) => {
    console.log('[COVERAGE-TEST] CLOSED. Code:', code, 'Reason:', reason.toString());
    lastCoverageResult = {
      ...lastCoverageResult,
      status: 'closed',
      closeCode: code,
      closeReason: reason.toString(),
      closedAt: new Date().toISOString(),
      totalMessagesReceived: messageCount
    };
  });

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log('[COVERAGE-TEST] Timeout erreicht, schließe Verbindung');
      ws.close();
    }
  }, 20000);
}

function getCoverageResult() {
  return lastCoverageResult;
}

module.exports = { runCoverageTest, getCoverageResult };
