'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  configureDisconnectAlerts,
  sendDisconnectAlert,
  retryPendingDisconnectAlerts,
  INCIDENT_COMPONENT,
} = require('../src/services/monitoring/disconnect-alert');

function makeFakeDb({ settings = {}, configs = {} } = {}) {
  const platform = new Map(Object.entries(settings));
  const incidents = new Map(); // `${component}|${scope}` -> { component, scope, status, notified_channels }
  return {
    incidents,
    isConfigured: () => true,
    query: async (sql, params = []) => {
      if (/SELECT value FROM platform_settings/i.test(sql)) {
        return { rows: platform.has(params[0]) ? [{ value: platform.get(params[0]) }] : [] };
      }
      if (/SELECT config FROM bot_configs/i.test(sql)) {
        const cfg = configs[params[0]];
        return { rows: cfg ? [{ config: cfg }] : [] };
      }
      if (/INSERT INTO health_incidents/i.test(sql)) {
        const [component, scope] = params;
        const key = `${component}|${scope || 'global'}`;
        if (incidents.has(key) && incidents.get(key).status === 'open') return { rowCount: 0, rows: [] };
        incidents.set(key, { component, scope: scope || 'global', status: 'open', notified_channels: null });
        return { rowCount: 1, rows: [{ id: key }] };
      }
      // list open + unnotified for a component
      if (/SELECT scope FROM health_incidents[\s\S]*status\s*=\s*'open'/i.test(sql)) {
        const [component] = params;
        const rows = [...incidents.values()]
          .filter((i) => i.component === component && i.status === 'open'
            && (i.notified_channels === null || (Array.isArray(i.notified_channels) && i.notified_channels.length === 0)))
          .map((i) => ({ scope: i.scope }));
        return { rows };
      }
      // getOpenIncident
      if (/SELECT[\s\S]*notified_channels[\s\S]*FROM health_incidents[\s\S]*status\s*=\s*'open'/i.test(sql)) {
        const [component, scope] = params;
        const row = incidents.get(`${component}|${scope || 'global'}`);
        return { rows: row && row.status === 'open' ? [{ notified_channels: row.notified_channels }] : [] };
      }
      if (/UPDATE health_incidents[\s\S]*notified_channels/i.test(sql)) {
        const [component, scope, channels] = params;
        const row = incidents.get(`${component}|${scope || 'global'}`);
        if (row) row.notified_channels = JSON.parse(channels);
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function downOwnerBot() {
  return { sent: [], appState: { status: 'stopped' }, client: null };
}
function connectedOwnerBot() {
  const sent = [];
  return { sent, appState: { status: 'connected' }, client: { sendMessage: async (jid, text) => sent.push({ jid, text }) } };
}

test('failed first send is retried later and delivered exactly once, no resend after success', async () => {
  process.env.DISCONNECT_ALERT_RETRY_COOLDOWN_MS = '0'; // deterministic: no time-based skip in the test
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });

  // 1) logged_out fires while the owner bot is unavailable → first send fails.
  configureDisconnectAlerts({ getOwnerBot: async () => downOwnerBot(), database: db });
  const first = await sendDisconnectAlert({ userId: 'retryUser' });
  assert.deepEqual(first.channels, [], 'first send fails (owner bot down)');
  const key = `${INCIDENT_COMPONENT}|retryUser`;
  assert.equal(db.incidents.get(key).status, 'open');
  assert.equal(db.incidents.get(key).notified_channels, null, 'incident open but not notified');

  // A retry tick while still down changes nothing.
  await retryPendingDisconnectAlerts();
  assert.equal(db.incidents.get(key).notified_channels, null, 'still not delivered while owner bot is down');

  // 2) Owner bot recovers → the next retry tick delivers.
  const owner = connectedOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => owner, database: db });
  await retryPendingDisconnectAlerts();
  assert.equal(owner.sent.length, 1, 'retry delivered the alert once the owner bot is back');
  assert.equal(owner.sent[0].jid, '966501112222@s.whatsapp.net');
  assert.deepEqual(db.incidents.get(key).notified_channels, ['whatsapp_platform'], 'marked notified after success');

  // 3) Repeated retry ticks after success must NOT resend.
  await retryPendingDisconnectAlerts();
  await retryPendingDisconnectAlerts();
  assert.equal(owner.sent.length, 1, 'no resend after a successful delivery');

  delete process.env.DISCONNECT_ALERT_RETRY_COOLDOWN_MS;
});

test('a per-incident cooldown prevents rapid duplicate retry sends within the window', async () => {
  process.env.DISCONNECT_ALERT_RETRY_COOLDOWN_MS = '600000'; // 10 min window
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  configureDisconnectAlerts({ getOwnerBot: async () => downOwnerBot(), database: db });
  await sendDisconnectAlert({ userId: 'cdUser' });

  // First retry tick consumes the cooldown slot (attempted, still down → no delivery).
  await retryPendingDisconnectAlerts();
  // Even if the owner bot comes back immediately, a second tick inside the window is skipped.
  const owner = connectedOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => owner, database: db });
  await retryPendingDisconnectAlerts();
  assert.equal(owner.sent.length, 0, 'second tick within the cooldown window does not send');

  delete process.env.DISCONNECT_ALERT_RETRY_COOLDOWN_MS;
});

test('the health monitor drives the retry sweep each tick (existing periodic loop, no new system)', () => {
  const fs = require('fs');
  const path = require('path');
  const monitor = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'monitoring', 'health-monitor.js'), 'utf8');
  assert.match(monitor, /alertRetry/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /alertRetry:\s*retryPendingDisconnectAlerts/);
});
