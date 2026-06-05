'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceLength } = require('../src/services/ai/reply-validator');

test('enforceLength keeps short replies untouched', () => {
  assert.equal(enforceLength('رد قصير', 300), 'رد قصير');
});

test('enforceLength truncates at sentence boundary when over limit', () => {
  const long = 'الجملة الأولى مفيدة جداً ومختصرة. الجملة الثانية زائدة جداً وتتجاوز الحد المسموح به كثيراً جداً.';
  const out = enforceLength(long, 60);
  assert.ok(out.length <= 62, `len=${out.length}`);
  assert.ok(out.startsWith('الجملة الأولى'));
  assert.ok(!out.includes('الثانية'), `should not include second sentence, got: ${out}`);
});

test('enforceLength hard-cuts when no sentence boundary', () => {
  const out = enforceLength('كلمةطويلةجدا'.repeat(20), 60);
  assert.ok(out.length <= 61);
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

// ── Regression: token-level escalation matching (false positives) ──────────
test('detectEscalationIntent false for واحد substring (regression)', () => {
  assert.equal(detectEscalationIntent('أبي واحد بني'), false);
});
test('detectEscalationIntent false for الاحد substring (regression)', () => {
  assert.equal(detectEscalationIntent('ابي اطلب لين الاحد'), false);
});
test('detectEscalationIntent still true for أبي أكلم المدير (regression)', () => {
  assert.equal(detectEscalationIntent('أبي أكلم المدير'), true);
});
test('detectEscalationIntent still true for ودي أتواصل مع موظف (regression)', () => {
  assert.equal(detectEscalationIntent('ودي أتواصل مع موظف'), true);
});
test('enforceEscalationTag no spurious tag for أبي واحد بني (regression)', () => {
  const out = enforceEscalationTag('المنتج متوفر باللون البني.', ESC_CONFIG, 'أبي واحد بني');
  assert.ok(!out.includes('[تحويل:'), `should not contain escalation tag, got: ${out}`);
});

// ── Regression: cop-out false positives ──────────────────────────────────
test('isCopOut false for المختصر substring (regression)', () => {
  assert.equal(isCopOut('هذا من المختصر سعره 50 ريال'), false);
});
test('isCopOut false for polite تسمح لي without deflection context (regression)', () => {
  assert.equal(isCopOut('تسمح لي أوضح لك التفاصيل؟'), false);
});
test('isCopOut still true for combined deflection (regression)', () => {
  assert.equal(isCopOut('ودّي أأكد لك المعلومة من المختص، تسمح لي؟'), true);
});
test('isCopOut still true for بسأل المختص وأرجع لك (regression)', () => {
  assert.equal(isCopOut('بسأل المختص وأرجع لك'), true);
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
