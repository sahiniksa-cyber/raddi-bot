'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPersistSessionStateQuery,
  buildRuntimeAuthMetadata,
} = require('../src/services/bot/session-state-persistence');

test('buildRuntimeAuthMetadata stores runtime state separately from provider auth', () => {
  assert.deepEqual(buildRuntimeAuthMetadata({
    ready: true,
    qrVersion: 3,
    authFailureCount: 1,
    heartbeatFailures: 2,
  }), {
    ready: true,
    qrVersion: 3,
    authFailureCount: 1,
    heartbeatFailures: 2,
  });
});

test('persist session query preserves Baileys auth_state while updating runtime metadata', () => {
  const query = buildPersistSessionStateQuery({
    userId: 'user-1',
    phone: null,
    status: 'qr_ready',
    sessionPath: 'postgresql',
    desiredState: 'running',
    runtimeAuthState: { ready: false, qrVersion: 1, authFailureCount: 0, heartbeatFailures: 0 },
    nowFields: { lastQr: true, lastConnected: false, lastDisconnected: false },
    lastError: null,
    reconnectCount: 0,
  });

  assert.match(query.text, /jsonb_set\(\s*COALESCE\(whatsapp_sessions\.auth_state, '\{\}'::jsonb\)/);
  assert.match(query.text, /'\{runtime\}'/);
  assert.match(query.text, /EXCLUDED\.auth_state->'runtime'/);
  assert.doesNotMatch(query.text, /auth_state\s*=\s*EXCLUDED\.auth_state/);
  assert.deepEqual(JSON.parse(query.values[5]), {
    runtime: { ready: false, qrVersion: 1, authFailureCount: 0, heartbeatFailures: 0 },
  });
});
