'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractPhoneNumber } = require('../src/services/whatsapp/baileys-connection-manager');

test('extractPhoneNumber returns digits from senderPn for lid remoteJid', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
    senderPn: '966512345678@s.whatsapp.net',
  });
  assert.equal(phone, '966512345678');
});

test('extractPhoneNumber falls back to participantPn when senderPn is missing', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
    participantPn: '966587654321@s.whatsapp.net',
  });
  assert.equal(phone, '966587654321');
});

test('extractPhoneNumber returns digits from a regular remoteJid when no PN fields exist', () => {
  const phone = extractPhoneNumber({
    remoteJid: '966512345678@s.whatsapp.net',
  });
  assert.equal(phone, '966512345678');
});

test('extractPhoneNumber returns null when only lid identifiers are available', () => {
  const phone = extractPhoneNumber({
    remoteJid: '276282495500304@lid',
  });
  assert.equal(phone, null);
});

test('extractPhoneNumber ignores group and broadcast jids', () => {
  assert.equal(extractPhoneNumber({ remoteJid: '120363041234567890@g.us' }), null);
  assert.equal(extractPhoneNumber({ remoteJid: 'status@broadcast' }), null);
});

test('extractPhoneNumber handles null/undefined key gracefully', () => {
  assert.equal(extractPhoneNumber(null), null);
  assert.equal(extractPhoneNumber(undefined), null);
  assert.equal(extractPhoneNumber({}), null);
});

test('extractPhoneNumber strips non-digit characters', () => {
  assert.equal(extractPhoneNumber({ senderPn: '+966-512-345678@s.whatsapp.net' }), '966512345678');
});
