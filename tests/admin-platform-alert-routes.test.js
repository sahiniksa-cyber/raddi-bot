'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPlatformAlertHandlers } = require('../src/routes/admin.routes');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('GET /api/admin/platform-alert returns empty phone and url when unset', async () => {
  const { getPlatformAlert } = createPlatformAlertHandlers({ getPlatformSetting: async () => null });
  const res = fakeRes();
  await getPlatformAlert({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, setting: { phone: '', url: '' } });
});

test('GET /api/admin/platform-alert returns stored values', async () => {
  const store = { platformAlertPhone: { phone: '966500000001' }, platformUrl: { url: 'https://jwap.net' } };
  const { getPlatformAlert } = createPlatformAlertHandlers({ getPlatformSetting: async (k) => store[k] || null });
  const res = fakeRes();
  await getPlatformAlert({}, res);
  assert.deepEqual(res.body, { success: true, setting: { phone: '966500000001', url: 'https://jwap.net' } });
});

test('PUT /api/admin/platform-alert normalizes phone digits and trims url', async () => {
  const calls = [];
  const { putPlatformAlert } = createPlatformAlertHandlers({
    getPlatformSetting: async () => null,
    setPlatformSetting: async (key, value) => { calls.push({ key, value }); return value; },
  });
  const res = fakeRes();
  await putPlatformAlert({ body: { phone: '+966 50 123 4567', url: '  https://jwap.net  ' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, setting: { phone: '966501234567', url: 'https://jwap.net' } });
  assert.deepEqual(calls, [
    { key: 'platformAlertPhone', value: { phone: '966501234567' } },
    { key: 'platformUrl', value: { url: 'https://jwap.net' } },
  ]);
});

test('PUT /api/admin/platform-alert accepts clearing a value (empty string persisted, never invented)', async () => {
  const calls = [];
  const { putPlatformAlert } = createPlatformAlertHandlers({
    getPlatformSetting: async () => null,
    setPlatformSetting: async (key, value) => { calls.push({ key, value }); return value; },
  });
  const res = fakeRes();
  await putPlatformAlert({ body: { phone: '', url: '' } }, res);
  assert.deepEqual(res.body, { success: true, setting: { phone: '', url: '' } });
  assert.deepEqual(calls, [
    { key: 'platformAlertPhone', value: { phone: '' } },
    { key: 'platformUrl', value: { url: '' } },
  ]);
});
