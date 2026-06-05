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

const { enforceEscalationTag, detectEscalationIntent } = require('../src/services/ai/reply-validator');

const ESC_CONFIG = { escalationContacts: [{ name: 'المالك', phone: '0500000000' }] };

test('detectEscalationIntent true for explicit human request', () => {
  assert.equal(detectEscalationIntent('أبي أكلم المدير'), true);
  assert.equal(detectEscalationIntent('ودي أتواصل مع موظف'), true);
});
test('detectEscalationIntent false for normal question', () => {
  assert.equal(detectEscalationIntent('وش عندكم قهوة؟'), false);
});
test('enforceEscalationTag appends tag when intent present but tag missing', () => {
  const out = enforceEscalationTag('تمام بسجل طلبك ويتواصل معك المختص.', ESC_CONFIG, 'أبي أكلم المدير');
  assert.match(out, /\[تحويل:/);
});
test('enforceEscalationTag does nothing when tag already present', () => {
  const r = 'تمام. [تحويل:المالك|طلب تواصل]';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'أبي أكلم المدير'), r);
});
test('enforceEscalationTag does nothing when no intent', () => {
  const r = 'القهوة متوفرة عندنا.';
  assert.equal(enforceEscalationTag(r, ESC_CONFIG, 'وش عندكم قهوة؟'), r);
});

const { isCopOut, needsRepairForCopOut } = require('../src/services/ai/reply-validator');

test('isCopOut detects deflection phrases', () => {
  assert.equal(isCopOut('ودّي أأكد لك المعلومة من المختص، تسمح لي؟'), true);
  assert.equal(isCopOut('الشحن خلال 2-4 أيام عبر سمسا'), false);
});
test('needsRepairForCopOut true when deflecting despite a matched policy', () => {
  const matched = [{ keyword: 'الشحن', reply: 'الشحن عبر سمسا خلال 2-4 أيام', score: 3 }];
  assert.equal(needsRepairForCopOut('أأكد لك من المختص، تسمح لي؟', matched), true);
});
test('needsRepairForCopOut false when no matched policy (legit deflection)', () => {
  assert.equal(needsRepairForCopOut('أأكد لك من المختص، تسمح لي؟', []), false);
});

const { validateAndRepair } = require('../src/services/ai/reply-validator');

test('validateAndRepair applies deterministic fixes without regenerate', async () => {
  const out = await validateAndRepair({
    reply: 'تمام بسجل طلبك.',
    config: ESC_CONFIG, customerText: 'أبي أكلم المدير', matched: [],
    regenerate: async () => { throw new Error('should not be called'); },
  });
  assert.match(out, /\[تحويل:/);          // أُضيفت العلامة حتمياً
});

test('validateAndRepair regenerates once on cop-out then keeps better reply', async () => {
  const matched = [{ keyword: 'الشحن', reply: 'الشحن عبر سمسا خلال 2-4 أيام', score: 3 }];
  let calls = 0;
  const out = await validateAndRepair({
    reply: 'أأكد لك من المختص، تسمح لي؟',
    config: {}, customerText: 'متى يوصلني؟', matched,
    regenerate: async () => { calls++; return 'الشحن عبر سمسا خلال 2-4 أيام عمل'; },
  });
  assert.equal(calls, 1);
  assert.match(out, /سمسا/);
});

test('validateAndRepair returns original when regenerate also bad (no infinite loop)', async () => {
  const matched = [{ keyword: 'الشحن', reply: 'x', score: 3 }];
  let calls = 0;
  const out = await validateAndRepair({
    reply: 'أأكد لك من المختص، تسمح لي؟',
    config: {}, customerText: 'متى يوصلني؟', matched,
    regenerate: async () => { calls++; return 'أأكد لك من المختص مرة ثانية، تسمح لي؟'; },
  });
  assert.equal(calls, 1);                  // مرة واحدة فقط
  assert.ok(typeof out === 'string' && out.length > 0);
});
