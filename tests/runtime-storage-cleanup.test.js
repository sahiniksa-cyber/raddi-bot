'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanupRuntimeStorage } = require('../src/services/bot/runtime-bot');

test('cleanupRuntimeStorage removes legacy whatsapp-web session data when using Baileys', () => {
  const previousEngine = process.env.WA_ENGINE;
  process.env.WA_ENGINE = 'baileys';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-runtime-cleanup-'));
  const userDir = path.join(root, 'data', 'user-1');
  const legacySession = path.join(userDir, 'session', 'Default', 'Cache');
  const baileysSession = path.join(userDir, 'baileys-session');
  const wawebCache = path.join(userDir, '.waweb-cache');
  fs.mkdirSync(legacySession, { recursive: true });
  fs.mkdirSync(baileysSession, { recursive: true });
  fs.mkdirSync(wawebCache, { recursive: true });
  fs.writeFileSync(path.join(legacySession, 'blob.bin'), 'cache');
  fs.writeFileSync(path.join(userDir, 'keep.txt'), 'keep');

  try {
    cleanupRuntimeStorage(root);

    assert.equal(fs.existsSync(path.join(userDir, 'session')), false);
    assert.equal(fs.existsSync(baileysSession), false);
    assert.equal(fs.existsSync(wawebCache), false);
    assert.equal(fs.existsSync(path.join(userDir, 'keep.txt')), true);
  } finally {
    if (previousEngine === undefined) delete process.env.WA_ENGINE;
    else process.env.WA_ENGINE = previousEngine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupRuntimeStorage keeps whatsapp-web session data when that engine is active', () => {
  const previousEngine = process.env.WA_ENGINE;
  process.env.WA_ENGINE = 'whatsapp-web';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-runtime-cleanup-'));
  const userDir = path.join(root, 'data', 'user-1');
  const activeSession = path.join(userDir, 'session', 'Default');
  fs.mkdirSync(activeSession, { recursive: true });
  fs.writeFileSync(path.join(activeSession, 'state.json'), '{}');

  try {
    cleanupRuntimeStorage(root);

    assert.equal(fs.existsSync(path.join(userDir, 'session')), true);
  } finally {
    if (previousEngine === undefined) delete process.env.WA_ENGINE;
    else process.env.WA_ENGINE = previousEngine;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
