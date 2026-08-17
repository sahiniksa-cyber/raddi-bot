'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createBotController } = require('../src/controllers/bot.controller');

function createResponse() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function controllerFor(appState) {
  return createBotController({
    getUserBot: () => ({ config: {}, appState: { qrString: null, logs: [], ...appState }, totalChatsHandled: 0 }),
  });
}

function statusBody(appState) {
  const res = createResponse();
  controllerFor(appState).status({ session: { userId: 'u1' } }, res);
  return res.body;
}

test('status exposes connectionTruth=CONNECTED for a live socket', () => {
  assert.equal(statusBody({ status: 'connected', desiredState: 'running' }).connectionTruth, 'CONNECTED');
});

test('status: desiredState=running but socket stopped is NEVER reported as CONNECTED', () => {
  const body = statusBody({ status: 'stopped', desiredState: 'running' });
  assert.notEqual(body.connectionTruth, 'CONNECTED');
  assert.equal(body.connectionTruth, 'DISCONNECTED');
});

test('status: loggedOut terminal disconnect surfaces QR_REQUIRED (no button press needed)', () => {
  const body = statusBody({
    status: 'stopped',
    desiredState: 'running',
    lastDisconnect: { statusCode: 401, reason: 'loggedOut' },
  });
  assert.equal(body.connectionTruth, 'QR_REQUIRED');
});

test('status: transient reconnect stays RECONNECTING (not QR_REQUIRED)', () => {
  assert.equal(statusBody({ status: 'reconnecting', desiredState: 'running' }).connectionTruth, 'RECONNECTING');
});

test('dashboard renders the QR_REQUIRED / re-link state driven by connectionTruth', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /connectionTruth/);
  assert.match(html, /QR_REQUIRED/);
  assert.match(html, /تم فصل الربط/);
});
