'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isCustomerBlocked, normalizeNumber } = require('../src/services/whatsapp/do-not-reply');

// ── normalizeNumber: every representation of one Saudi mobile collapses to the
// same national-significant digits ───────────────────────────────────────────
test('normalizeNumber reduces all formats of the same number to one form', () => {
  const forms = [
    '+966501234567',
    '00966501234567',
    '966501234567',
    '0501234567',
    '501234567',
    '966501234567@c.us',
    '966501234567@s.whatsapp.net',
    '966501234567:12@s.whatsapp.net',
  ];
  const norm = forms.map(normalizeNumber);
  norm.forEach(n => assert.equal(n, '501234567', `form did not normalise: got ${n}`));
});

test('normalizeNumber returns empty for junk/empty input', () => {
  assert.equal(normalizeNumber(''), '');
  assert.equal(normalizeNumber(null), '');
  assert.equal(normalizeNumber('@lid'), '');
});

// ── isCustomerBlocked: number-only matching, name is ignored ──────────────────
function cfg(list) { return { doNotReplyList: list }; }

test('blocks when the sender jid matches a listed number (different formats)', () => {
  const config = cfg([{ number: '0501234567', name: 'زبون مزعج' }]);
  assert.equal(isCustomerBlocked(config, '966501234567@s.whatsapp.net', ''), true);
  assert.equal(isCustomerBlocked(config, '', '+966 50 123 4567'), true);
});

test('does NOT block a different number', () => {
  const config = cfg([{ number: '0501234567', name: 'x' }]);
  assert.equal(isCustomerBlocked(config, '966509999999@c.us', '966509999999'), false);
});

test('the merchant-assigned name never causes a match (number-only)', () => {
  const config = cfg([{ number: '0501234567', name: 'محمد' }]);
  // a different person whose pushName is also محمد must NOT be blocked
  assert.equal(isCustomerBlocked(config, '966555555555@c.us', '966555555555'), false);
});

test('empty / missing list never blocks', () => {
  assert.equal(isCustomerBlocked({}, '966501234567@c.us', '966501234567'), false);
  assert.equal(isCustomerBlocked(cfg([]), '966501234567@c.us', '966501234567'), false);
});

test('ignores garbage/too-short list entries (no accidental broad block)', () => {
  const config = cfg([{ number: '12', name: 'bad' }, { number: '', name: 'empty' }]);
  assert.equal(isCustomerBlocked(config, '966501234567@c.us', '966501234567'), false);
});

test('tolerates a raw string entry as well as an object entry', () => {
  assert.equal(isCustomerBlocked(cfg(['0501234567']), '966501234567@c.us', ''), true);
});
