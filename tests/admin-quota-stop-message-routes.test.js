'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuotaStopMessageHandlers } = require('../src/routes/admin.routes');

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

test('GET /api/admin/quota-stop-message returns default when unset', async () => {
  const deps = {
    getPlatformSetting: async () => null,
  };
  const { getQuotaStopMessage } = createQuotaStopMessageHandlers(deps);
  const res = fakeRes();
  await getQuotaStopMessage({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    setting: { enabled: false, text: '' },
  });
});

test('GET /api/admin/quota-stop-message returns stored setting', async () => {
  const stored = { enabled: true, text: 'رسالة توقف الكوتا' };
  const deps = {
    getPlatformSetting: async () => stored,
  };
  const { getQuotaStopMessage } = createQuotaStopMessageHandlers(deps);
  const res = fakeRes();
  await getQuotaStopMessage({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, setting: stored });
});

test('PUT /api/admin/quota-stop-message persists and returns the setting', async () => {
  const calls = [];
  const deps = {
    getPlatformSetting: async () => null,
    setPlatformSetting: async (key, value) => { calls.push({ key, value }); return value; },
  };
  const { putQuotaStopMessage } = createQuotaStopMessageHandlers(deps);
  const req = { body: { enabled: true, text: 'رسالة' } };
  const res = fakeRes();
  await putQuotaStopMessage(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    setting: { enabled: true, text: 'رسالة' },
  });
  assert.deepEqual(calls, [{ key: 'quotaStopMessage', value: { enabled: true, text: 'رسالة' } }]);
});

test('PUT /api/admin/quota-stop-message coerces enabled to false when not true', async () => {
  const calls = [];
  const deps = {
    getPlatformSetting: async () => null,
    setPlatformSetting: async (key, value) => { calls.push({ key, value }); return value; },
  };
  const { putQuotaStopMessage } = createQuotaStopMessageHandlers(deps);
  const req = { body: { enabled: 'yes', text: '  مرحبا  ' } };
  const res = fakeRes();
  await putQuotaStopMessage(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    setting: { enabled: false, text: 'مرحبا' },
  });
});

test('PUT /api/admin/quota-stop-message handles missing body gracefully', async () => {
  const calls = [];
  const deps = {
    getPlatformSetting: async () => null,
    setPlatformSetting: async (key, value) => { calls.push({ key, value }); return value; },
  };
  const { putQuotaStopMessage } = createQuotaStopMessageHandlers(deps);
  const req = {};
  const res = fakeRes();
  await putQuotaStopMessage(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    setting: { enabled: false, text: '' },
  });
});
