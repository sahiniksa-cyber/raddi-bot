'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

test('appState exposes connection diagnostics used by dashboard and workers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-runtime-state-'));
  const bot = new RuntimeBot('user-1', {
    dataDir: tmp,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      all: () => [],
      log: () => {},
    },
  });

  bot.sessionDesiredState = 'running';
  bot.connection.state = () => ({
    status: 'connected',
    ready: true,
    phone: '966500000000',
    qrVersion: 0,
    error: null,
    reconnectCount: 3,
    authFailureCount: 0,
    heartbeatFailures: 0,
    statusAgeMs: 12345,
    lastProbeState: 'CONNECTED',
  });

  const state = bot.appState;

  assert.equal(state.ready, true);
  assert.equal(state.reconnectCount, 3);
  assert.equal(state.statusAgeMs, 12345);
  assert.equal(state.lastProbeState, 'CONNECTED');
  assert.equal(state.desiredState, 'running');
  assert.equal(state.whatsappEngine, bot.whatsappEngine);

  fs.rmSync(tmp, { recursive: true, force: true });
});

