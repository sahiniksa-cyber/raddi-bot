'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDisconnectAlertMessage,
  configureDisconnectAlerts,
  sendDisconnectAlert,
  resolveDisconnectIncident,
  INCIDENT_COMPONENT,
} = require('../src/services/monitoring/disconnect-alert');

// ---- In-memory fake DB covering the four query shapes this path touches. ----
function makeFakeDb({ settings = {}, configs = {} } = {}) {
  const platform = new Map(Object.entries(settings));
  const incidents = new Map(); // `${component}|${scope}` -> { status, notified_channels }
  const db = {
    incidents,
    isConfigured: () => true,
    query: async (sql, params = []) => {
      if (/INSERT INTO platform_settings/i.test(sql)) {
        platform.set(params[0], typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]);
        return { rows: [] };
      }
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
        incidents.set(key, { status: 'open', notified_channels: null });
        return { rowCount: 1, rows: [{ id: key }] };
      }
      if (/SELECT[\s\S]*FROM health_incidents[\s\S]*WHERE component/i.test(sql) && /status\s*=\s*'open'/i.test(sql)) {
        const [component, scope] = params;
        const key = `${component}|${scope || 'global'}`;
        const row = incidents.get(key);
        return { rows: row && row.status === 'open' ? [{ notified_channels: row.notified_channels }] : [] };
      }
      if (/UPDATE health_incidents[\s\S]*notified_channels/i.test(sql)) {
        const [component, scope, channels] = params;
        const key = `${component}|${scope || 'global'}`;
        if (incidents.has(key)) incidents.get(key).notified_channels = JSON.parse(channels);
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE health_incidents[\s\S]*status\s*=\s*'resolved'/i.test(sql)) {
        const [component, scope] = params;
        const key = `${component}|${scope || 'global'}`;
        if (incidents.has(key) && incidents.get(key).status === 'open') {
          incidents.get(key).status = 'resolved';
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function fakeOwnerBot() {
  const sent = [];
  return { sent, appState: { status: 'connected' }, client: { sendMessage: async (jid, text) => sent.push({ jid, text }) } };
}

// ---------------------------- message builder (Unit C) ----------------------------

test('message is minimal: no store → exact spec text', () => {
  const msg = buildDisconnectAlertMessage({ platformUrl: 'https://jwap.net' });
  assert.equal(msg, 'تم فصل ربط واتساب.\nلإعادة الربط:\nhttps://jwap.net');
});

test('message includes the store name when it exists', () => {
  const msg = buildDisconnectAlertMessage({ storeName: 'بروستور', platformUrl: 'https://jwap.net' });
  assert.equal(msg, 'تم فصل ربط واتساب لمتجر بروستور.\nلإعادة الربط:\nhttps://jwap.net');
});

test('message never invents a URL when platform URL is missing', () => {
  assert.equal(buildDisconnectAlertMessage({ storeName: 'بروستور' }), 'تم فصل ربط واتساب لمتجر بروستور.');
  assert.equal(buildDisconnectAlertMessage({}), 'تم فصل ربط واتساب.');
});

test('message leaks nothing sensitive: no userId, code, stack, token, QR, phone, session', () => {
  const msg = buildDisconnectAlertMessage({ storeName: 'X', platformUrl: 'https://jwap.net' });
  for (const forbidden of ['userId', 'user_id', 'code=', 'stack', 'token', 'QR', 'session', 'creds', '@s.whatsapp.net', '401']) {
    assert.ok(!msg.includes(forbidden), `message must not contain "${forbidden}"`);
  }
});

// ---------------------------- send / transport / dedup (Unit D) ----------------------------

test('no platform phone configured → NO alert, internal diagnostic only, no OWNER_ALERT_PHONE fallback', async () => {
  const prevOwner = process.env.OWNER_ALERT_PHONE;
  process.env.OWNER_ALERT_PHONE = '966599999999'; // must be ignored entirely
  const db = makeFakeDb({ settings: {} }); // platformAlertPhone unset
  const bot = fakeOwnerBot();
  try {
    configureDisconnectAlerts({ getOwnerBot: async () => bot, database: db });
    const result = await sendDisconnectAlert({ userId: 'u1' });
    assert.deepEqual(result.channels, []);
    assert.equal(result.skipped, 'no_platform_phone');
    assert.equal(bot.sent.length, 0, 'nothing sent when platform phone is empty');
    assert.equal(db.incidents.size, 0, 'no incident opened when we cannot notify');
  } finally {
    if (prevOwner === undefined) delete process.env.OWNER_ALERT_PHONE; else process.env.OWNER_ALERT_PHONE = prevOwner;
  }
});

test('with platform phone → sends ONE alert to that number via the independent owner bot', async () => {
  const db = makeFakeDb({
    settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } },
    configs: { u1: { storeName: 'بروستور' } },
  });
  const bot = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => bot, database: db });
  const result = await sendDisconnectAlert({ userId: 'u1' });
  assert.deepEqual(result.channels, ['whatsapp_platform']);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].jid, '966501112222@s.whatsapp.net');
  assert.equal(bot.sent[0].text, 'تم فصل ربط واتساب لمتجر بروستور.\nلإعادة الربط:\nhttps://jwap.net');
});

test('dedup: repeated events for the same open incident send exactly one alert', async () => {
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  const bot = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => bot, database: db });
  await sendDisconnectAlert({ userId: 'u1' });
  const second = await sendDisconnectAlert({ userId: 'u1' });
  const third = await sendDisconnectAlert({ userId: 'u1' });
  assert.equal(bot.sent.length, 1, 'only one alert for repeated same-incident events');
  assert.equal(second.skipped, 'already_notified');
  assert.equal(third.skipped, 'already_notified');
});

test('incident closes on reconnect, then a future disconnect alerts again', async () => {
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  const bot = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => bot, database: db });
  await sendDisconnectAlert({ userId: 'u1' });          // alert #1
  await sendDisconnectAlert({ userId: 'u1' });          // deduped
  await resolveDisconnectIncident({ userId: 'u1' });    // reconnected → incident cleared
  await sendDisconnectAlert({ userId: 'u1' });          // alert #2 allowed
  assert.equal(bot.sent.length, 2, 'a fresh incident after resolution alerts again');
});

test('delivery failure (owner bot down) does NOT burn the incident — retry can still deliver', async () => {
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  const downBot = { appState: { status: 'stopped' }, client: null };
  configureDisconnectAlerts({ getOwnerBot: async () => downBot, database: db });
  const first = await sendDisconnectAlert({ userId: 'u1' });
  assert.deepEqual(first.channels, []); // nothing delivered

  const upBot = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => upBot, database: db });
  const retry = await sendDisconnectAlert({ userId: 'u1' }); // same incident, now deliverable
  assert.deepEqual(retry.channels, ['whatsapp_platform']);
  assert.equal(upBot.sent.length, 1);
});

test('tenant isolation: A disconnect opens an incident only for A, never for B', async () => {
  const db = makeFakeDb({ settings: { platformAlertPhone: { phone: '966501112222' }, platformUrl: { url: 'https://jwap.net' } } });
  const bot = fakeOwnerBot();
  configureDisconnectAlerts({ getOwnerBot: async () => bot, database: db });
  await sendDisconnectAlert({ userId: 'tenantA' });
  assert.ok(db.incidents.has(`${INCIDENT_COMPONENT}|tenantA`));
  assert.ok(!db.incidents.has(`${INCIDENT_COMPONENT}|tenantB`));
  // B still alerts independently.
  const b = await sendDisconnectAlert({ userId: 'tenantB' });
  assert.deepEqual(b.channels, ['whatsapp_platform']);
});
