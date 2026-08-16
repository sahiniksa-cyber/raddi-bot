'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toCanonicalPhone, canonicalDigits, sameCanonicalPhone } = require('../src/services/identity/phone');

// Canonical form = full international digits, no '+'  (e.g. 966501234567).
// This MATCHES the existing campaign_contacts.normalized_phone format so a
// backfill lines up, and is what the CRM identity layer keys customers on.

test('Saudi national forms all collapse to one canonical', () => {
  const forms = ['0501234567', '501234567', '966501234567', '+966501234567', '00966501234567', ' +966 50 123 4567 '];
  for (const f of forms) {
    const r = toCanonicalPhone(f);
    assert.equal(r.canonical, '966501234567', `form ${f}`);
    assert.equal(r.e164, '+966501234567', `form ${f}`);
    assert.equal(r.national, '501234567', `form ${f}`);
    assert.equal(r.countryCode, '966', `form ${f}`);
  }
});

test('canonicalDigits is the quick helper returning just the digits (or null)', () => {
  assert.equal(canonicalDigits('0501234567'), '966501234567');
  assert.equal(canonicalDigits('غير صحيح'), null);
});

test('explicit +country international numbers pass through (not Saudi-forced)', () => {
  const uae = toCanonicalPhone('+971501234567');
  assert.equal(uae.canonical, '971501234567');
  assert.equal(uae.countryCode, '971');
  assert.equal(uae.national, '501234567');

  const egy = toCanonicalPhone('0020221234567'); // 00 + Egypt CC 20
  assert.equal(egy.canonical, '20221234567');
  assert.equal(egy.countryCode, '20');
});

test('defaultCountry is configurable (not hardcoded Saudi)', () => {
  // A bare national number with a UAE default country.
  const r = toCanonicalPhone('0501234567', { defaultCountry: 'AE' });
  assert.equal(r.canonical, '971501234567');
  assert.equal(r.countryCode, '971');
});

test('rejects junk / too-short / empty', () => {
  assert.equal(toCanonicalPhone(''), null);
  assert.equal(toCanonicalPhone(null), null);
  assert.equal(toCanonicalPhone('abc'), null);
  assert.equal(toCanonicalPhone('123'), null);
  assert.equal(toCanonicalPhone('   '), null);
});

test('strips WhatsApp JID suffixes and rejects group/lid/broadcast', () => {
  assert.equal(toCanonicalPhone('966501234567@s.whatsapp.net').canonical, '966501234567');
  assert.equal(toCanonicalPhone('966501234567@c.us').canonical, '966501234567');
  // A @lid is NOT a phone — must not be misread as digits.
  assert.equal(toCanonicalPhone('123456789012@lid'), null);
  assert.equal(toCanonicalPhone('12345-67890@g.us'), null);
  assert.equal(toCanonicalPhone('status@broadcast'), null);
});

test('sameCanonicalPhone compares across mixed input forms', () => {
  assert.equal(sameCanonicalPhone('0501234567', '+966 50 123 4567'), true);
  assert.equal(sameCanonicalPhone('0501234567', '0501234568'), false);
  assert.equal(sameCanonicalPhone('abc', '0501234567'), false);
  assert.equal(sameCanonicalPhone(null, null), false);
});
