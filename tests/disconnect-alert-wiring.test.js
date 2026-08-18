'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The loggedOut → alert and connected → resolve wiring lives in runtime-bot, and
// the service is configured in server.js. These guards stop the wiring from
// silently regressing (the exact failure that made the production alert never
// arrive). The behavioural proof is the integration test.
test('runtime-bot wires logged_out → sendDisconnectAlert and ready → resolveDisconnectIncident', () => {
  const rb = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), 'utf8');
  assert.match(rb, /connection\.on\('logged_out'/);
  assert.match(rb, /sendDisconnectAlert\(\{ userId: this\.userId \}\)/);
  assert.match(rb, /resolveDisconnectIncident\(\{ userId: this\.userId \}\)/);
});

test('server configures the disconnect alert with an independent owner-bot transport', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /configureDisconnectAlerts\(\{ getOwnerBot: resolveOwnerBot \}\)/);
});

test('the disconnect alert never reads OWNER_ALERT_PHONE (platform phone only)', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'monitoring', 'disconnect-alert.js'), 'utf8');
  assert.doesNotMatch(svc, /process\.env\.OWNER_ALERT_PHONE/);
  assert.match(svc, /getPlatformAlertPhone/);
});
