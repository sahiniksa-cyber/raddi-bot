'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWhatsappEngine } = require('../src/services/bot/engine-config');

test('defaults to baileys when WA_ENGINE is empty', () => {
  assert.equal(resolveWhatsappEngine({}), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: '' }), 'baileys');
});

test('accepts explicit whatsapp-web as fallback engine', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp-web' }), 'whatsapp-web');
});

test('normalizes aliases to stable engine names', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'BAILEYS' }), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp_web' }), 'whatsapp-web');
});
