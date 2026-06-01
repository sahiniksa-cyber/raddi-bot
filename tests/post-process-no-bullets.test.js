'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAvoidedContent } = require('../lib/post-process-reply');

test('strips unicode bullet markers at line start', () => {
  const out = stripAvoidedContent('عندنا الخيارات:\n• الباقة الشهرية\n• الباقة السنوية');
  assert.doesNotMatch(out, /•/);
  assert.match(out, /الباقة الشهرية/);
  assert.match(out, /الباقة السنوية/);
});

test('strips markdown dash/asterisk bullets at line start', () => {
  const out = stripAvoidedContent('الأسعار:\n- 50 ريال شهري\n* 500 ريال سنوي');
  assert.doesNotMatch(out, /^\s*[-*]\s/m);
  assert.match(out, /50 ريال شهري/);
  assert.match(out, /500 ريال سنوي/);
});

test('strips markdown bold but keeps the words', () => {
  const out = stripAvoidedContent('السعر **199 ريال** فقط');
  assert.doesNotMatch(out, /\*\*/);
  assert.match(out, /199 ريال/);
});

test('keeps dashes inside a line (phone numbers / ranges)', () => {
  const out = stripAvoidedContent('التوصيل خلال 10-15 يوم على الرقم 0501234567');
  assert.match(out, /10-15/);
  assert.match(out, /0501234567/);
});

test('does not damage normal connected sentences', () => {
  const reply = 'أهلاً فيك! السعر 199 ريال ويشمل التوصيل المجاني 🌷';
  assert.equal(stripAvoidedContent(reply), reply);
});

test('returns original when stripping would empty the reply', () => {
  const out = stripAvoidedContent('•');
  assert.equal(out, '•');
});
