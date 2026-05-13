'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeOutboundJid } = require('../src/services/whatsapp/baileys-connection-manager');

test('normalizeOutboundJid preserves Baileys LID chat ids', () => {
  assert.equal(
    normalizeOutboundJid('278571713060916@lid'),
    '278571713060916@lid',
  );
});

test('normalizeOutboundJid converts legacy whatsapp-web chat ids to phone JIDs', () => {
  assert.equal(
    normalizeOutboundJid('966501234567@c.us'),
    '966501234567@s.whatsapp.net',
  );
});
