'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWhatsappEngine } = require('../src/services/bot/engine-config');

test('defaults to baileys when WA_ENGINE is empty', () => {
  assert.equal(resolveWhatsappEngine({}), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: '' }), 'baileys');
});

test('rejects the retired whatsapp-web engine setting', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp-web' }), 'baileys');
});

test('normalizes Baileys aliases but rejects retired engine aliases', () => {
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'BAILEYS' }), 'baileys');
  assert.equal(resolveWhatsappEngine({ WA_ENGINE: 'whatsapp_web' }), 'baileys');
});
