const WebSocket = require('ws');

let lastTestResult = { status: 'not run yet' };

function runAisTest() {
  const apiKey = process.env.AISSTREAM_API_KEY;
  
  if (!apiKey) {
    lastTestResult = { status: 'error', message: 'AISSTREAM_API_KEY nicht gesetzt in Railway env vars' };
    console.log('[AIS-TEST]', lastTestResult);
    return;
  }

  lastTestResult = { status: 'connecting', startedAt: new Date().toISOString() };
  console.log('[AIS-TEST] Verbindung wird aufgebaut...');

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  const mmsiList = [
    319225400, 319032600, 227003660, 319040900, 319111900,
    319104900, 319069900, 319201400, 319093400
  ];

  let messageCount = 0;

  ws.on('open', () => {
    console.log('[AIS-TEST] WebSocket OPEN');
    lastTestResult = { status: 'connected', connectedAt: new Date().toISOString() };

    const subscriptionMessage = {
      APIKey: apiKey,
      BoundingBoxes: [[[-180, -90], [180, 90]]],
      FiltersShipMMSI: mmsiList.map(String)
    };

    ws.send(JSON.stringify(subscriptionMessage));
    console.log('[AIS-TEST] Subscription gesendet für', mmsiList.length, 'MMSIs');
  });

  ws.on('message', (data) => {
    messageCount++;
    const parsed = JSON.parse(data.toString());
    console.log('[AIS-TEST] Nachricht #' + messageCount, JSON.stringify(parsed).slice(0, 200));
    lastTestResult = {
      status: 'receiving_data',
      messageCount,
      lastMessageAt: new Date().toISOString(),
      sample: parsed
    };
  });

  ws.on('error', (err) => {
    console.error('[AIS-TEST] ERROR:', err.message);
    lastTestResult = { status: 'error', message: err.message, errorAt: new Date().toISOString() };
  });

  ws.on('close', (code, reason) => {
    console.log('[AIS-TEST] CLOSED. Code:', code, 'Reason:', reason.toString());
    lastTestResult = {
      ...lastTestResult,
      status: 'closed',
      closeCode: code,
      closeReason: reason.toString(),
      closedAt: new Date().toISOString(),
      totalMessagesReceived: messageCount
    };
  });

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log('[AIS-TEST] Timeout erreicht, schließe Verbindung');
      ws.close();
    }
  }, 30000);
}

function getLastTestResult() {
  return lastTestResult;
}

module.exports = { runAisTest, getLastTestResult };
