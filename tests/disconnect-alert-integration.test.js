'use strict';

// REAL-PATH proof: drives the actual BaileysConnectionManager close handler
// (the real 401/428 classification), wired exactly the way runtime-bot wires it
// (logged_out → sendDisconnectAlert, ready → resolveDisconnectIncident), and
// asserts the end-to-end behaviour a merchant/platform actually experiences.
// No real WhatsApp socket, no real DB — but the classification and dispatch code
// under test is the production code, not a stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
const {
  configureDisconnectAlerts,
  sendDisconnectAlert,
  resolveDisconnectIncident,
  INCIDENT_COMPONENT,
} = require('../src/services/monitoring/disconnect-alert');

function makeFakeDb({ settings = {}, configs = {} } = {}) {
  const platform = new Map(Object.entries(settings));
  const incidents = new Map();
  return {
    incidents,
    isConfigured: () => true,
    ping: async () => true,
    query: async (sql, params = []) => {
      if (/SELECT value FROM platform_settings/i.test(sql)) {
        return { rows: platform.has(params[0]) ? [{ value: platform.get(params[0]) }] : [] };
      }
      if (/SELECT config FROM bot_configs/i.test(sql)) {
        const cfg = configs[params[0]];
        return { rows: cfg ? [{ config: cfg }] : [] };
      }
      if (/INSERT INTO health_incidents/i.test(sql)) {
        const key = `${params[0]}|${params[1] || 'global'}`;
        if (incidents.has(key) && incidents.get(key).status === 'open') return { rowCount: 0, rows: [] };
        incidents.set(key, { status: 'open', notified_channels: null });
        return { rowCount: 1, rows: [{ id: key }] };
      }
      if (/SELECT[\s\S]*FROM health_incidents[\s\S]*status\s*=\s*'open'/i.test(sql)) {
        const key = `${params[0]}|${params[1] || 'global'}`;
        const row = incidents.get(key);
        return { rows: row && row.status === 'open' ? [{ notified_channels: row.notified_channels }] : [] };
      }
      if (/UPDATE health_incidents[\s\S]*notified_channels/i.test(sql)) {
        const key = `${params[0]}|${params[1] || 'global'}`;
        if (incidents.has(key)) incidents.get(key).notified_channels = JSON.parse(params[2]);
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE health_incidents[\s\S]*status\s*=\s*'resolved'/i.test(sql)) {
        const key = `${params[0]}|${params[1] || 'global'}`;
        if (incidents.has(key) && incidents.get(key).status === 'open') {
          incidents.get(key).status = 'resolved';
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function fakeOwnerBot() {
  const sent = [];
  return { sent, appState: { status: 'connected' }, client: { sendMessage: async (jid, text) => sent.push({ jid, text }) } };
}

function makeManager(userId, db) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-int-'));
  const silent = { info() {}, warn() {}, error() {}, log() {}, all: () => [] };
  const mgr = new BaileysConnectionManager({ userId, dataDir, logger: silent, database: db });
  mgr._running = true; // pretend a live socket existed
  // Wire the listeners exactly as runtime-bot.js does.
  mgr.on('logged_out', () => { sendDisconnectAlert({ userId }).catch(() => {}); });
  mgr.on('ready', () => { resolveDisconnectIncident({ userId }).catch(() => {}); });
  return { mgr, dataDir };
}

const closeUpdate = (statusCode) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });

test('REAL PATH: terminal loggedOut(401) → status stopped, ONE platform alert delivered, then resolves and re-alerts', async () => {
  const db = makeFakeDb({
    settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } },
    configs: { storeUser: { storeName: 'بروستور' } },
  });
  const owner = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => owner, database: db });

  const { mgr } = makeManager('storeUser', db);
  let loggedOut = 0;
  mgr.on('logged_out', () => { loggedOut++; });

  // Omit the generation arg → defaults to the manager's current generation
  // (the loggedOut branch bumps it, so later calls must use the live value).
  await mgr.handleConnectionUpdate(closeUpdate(401), 0, mgr._socketGeneration);
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget alert settle

  assert.equal(loggedOut, 1, 'real manager classified 401 as loggedOut');
  assert.equal(mgr.status, 'stopped', 'session is stopped (not connected)');
  assert.equal(owner.sent.length, 1, 'exactly one platform alert delivered');
  assert.equal(owner.sent[0].jid, '966501112222@s.whatsapp.net');
  assert.equal(owner.sent[0].text, 'تم فصل ربط واتساب لمتجر بروستور.\nلإعادة الربط:\nhttps://jwap.net');
  assert.equal(db.incidents.get(`${INCIDENT_COMPONENT}|storeUser`).status, 'open');

  // Reconnect closes the incident, a fresh severance alerts again.
  mgr.emit('ready', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(db.incidents.get(`${INCIDENT_COMPONENT}|storeUser`).status, 'resolved');

  mgr._running = true;
  await mgr.handleConnectionUpdate(closeUpdate(401), 0, mgr._socketGeneration);
  await new Promise((r) => setImmediate(r));
  assert.equal(owner.sent.length, 2, 'a genuinely new incident alerts again');
});

test('REAL PATH: transient close (428) does NOT log out and does NOT alert', async () => {
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  const owner = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => owner, database: db });

  const { mgr } = makeManager('storeUser2', db);
  let loggedOut = 0;
  mgr.on('logged_out', () => { loggedOut++; });

  try {
    await mgr.handleConnectionUpdate(closeUpdate(428), 0, 0);
    await new Promise((r) => setImmediate(r));
    assert.equal(loggedOut, 0, '428 is transient — never a logout');
    assert.equal(owner.sent.length, 0, 'no alert for a self-healing drop');
    assert.equal(db.incidents.size, 0, 'no incident opened for a transient drop');
  } finally {
    // The default branch scheduled a self-heal reconnect; stop it so the test
    // never touches the network.
    clearTimeout(mgr._retryTimer);
    mgr._retryTimer = null;
    mgr._running = false;
  }
});
