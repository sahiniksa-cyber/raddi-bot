'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceLength } = require('../src/services/ai/reply-validator');

test('enforceLength keeps short replies untouched', () => {
  assert.equal(enforceLength('رد قصير', 300), 'رد قصير');
});

test('enforceLength truncates at sentence boundary when over limit', () => {
  const long = 'الجملة الأولى مفيدة. الجملة الثانية زائدة جداً وتتجاوز الحد المسموح به كثيراً جداً.';
  const out = enforceLength(long, 30);
  assert.ok(out.length <= 32, `len=${out.length}`);
  assert.ok(out.startsWith('الجملة الأولى'));
});

test('enforceLength hard-cuts when no sentence boundary', () => {
  const out = enforceLength('كلمةطويلةجدا'.repeat(20), 30);
  assert.ok(out.length <= 31);
});
