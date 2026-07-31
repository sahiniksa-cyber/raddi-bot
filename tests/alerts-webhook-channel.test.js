'use strict';

// Behavioral tests for Phase 8: the out-of-band webhook alert channel. Uses an
// injected fake fetch so we verify it fires INDEPENDENTLY of the WhatsApp bot
// and DB, is best-effort (never throws), and reports failures without blocking
// the other channels.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertDispatcher } = require('../src/services/monitoring/alerts');

const incident = { key: 'storage', component: 'مساحة قاعدة البيانات', scope: 'global', severity: 'critical', detail: 'قاعدة البيانات 90%' };

test('webhook fires out-of-band even when WhatsApp AND email are unavailable', async () => {
  let posted = null;
  const dispatcher = createAlertDispatcher({
    getOwnerBot: null,          // WhatsApp channel down
    mailer: null,               // email off
    webhookUrl: 'https://alerts.example/hook',
    fetchImpl: async (url, opts) => { posted = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200 }; },
    logger: {},
  });
  const channels = await dispatcher.dispatch({ kind: 'open', incident });
  assert.deepEqual(channels, ['webhook'], 'only the independent webhook delivered');
  assert.equal(posted.url, 'https://alerts.example/hook');
  assert.equal(posted.body.severity, 'critical');
  assert.equal(posted.body.component, 'مساحة قاعدة البيانات');
});

test('no webhook URL configured → channel is a no-op (false)', async () => {
  const dispatcher = createAlertDispatcher({ webhookUrl: '', fetchImpl: async () => ({ ok: true }), logger: {} });
  assert.equal(await dispatcher.sendWebhook('open', incident, 'x'), false);
});

test('a failing webhook is best-effort: returns false, never throws', async () => {
  const dispatcher = createAlertDispatcher({
    webhookUrl: 'https://alerts.example/hook',
    fetchImpl: async () => { throw new Error('network down'); },
    logger: { warn() {} },
  });
  let result;
  await assert.doesNotReject(async () => { result = await dispatcher.sendWebhook('open', incident, 'x'); });
  assert.equal(result, false);
});

test('non-2xx response counts as failure', async () => {
  const dispatcher = createAlertDispatcher({
    webhookUrl: 'https://alerts.example/hook',
    fetchImpl: async () => ({ ok: false, status: 500 }),
    logger: {},
  });
  assert.equal(await dispatcher.sendWebhook('open', incident, 'x'), false);
});

test('webhook carries no secrets — only the incident summary fields', async () => {
  let body = null;
  const dispatcher = createAlertDispatcher({
    webhookUrl: 'https://alerts.example/hook',
    fetchImpl: async (url, opts) => { body = JSON.parse(opts.body); return { ok: true }; },
    logger: {},
  });
  await dispatcher.sendWebhook('open', incident, 'summary text');
  assert.deepEqual(Object.keys(body).sort(), ['at', 'component', 'detail', 'key', 'kind', 'scope', 'severity', 'text'].sort());
});
