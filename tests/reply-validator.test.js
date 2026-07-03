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

// Production 2026-07-02: a product-card reply was cut at the dot inside the URL
// ("https://prostoree." — the '.' in prostoree.com was taken as a sentence
// boundary). A reply carrying a link must NEVER be truncated (broken link).
test('enforceLength never truncates a reply containing a URL (keeps the link whole)', () => {
  // Long enough to exceed the limit, with the URL's dot (prostoree.com) sitting
  // inside the cut window — the exact production case that produced "https://prostoree.".
  const reply = 'رابط الاشتراك https://prostoree.com/NAADyOm وبعده شرح إضافي طويل جداً يتجاوز الحد المسموح به بمسافة كبيرة عشان يجبر القص';
  const out = enforceLength(reply, 60);
  assert.ok(out.includes('https://prostoree.com/NAADyOm'), 'the full URL must survive, not cut at the dot');
  assert.equal(out, reply, 'a URL-bearing reply is returned whole (never cut mid-link)');
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

// ── I1: escalation tag must survive length enforcement ───────────────────────
test('validateAndRepair: escalation tag survives length enforcement (I1)', async () => {
  const longReply = 'أهلاً وسهلاً فيك، يسعدني أساعدك في طلبك اليوم. ' + 'هذا رد طويل يقترب من الحد الأقصى المسموح به للطول حتى نتأكد أن القصّ يحدث فعلاً وبعدها نتحقق من بقاء علامة التحويل سليمة في نهاية الرد رغم القص. '.repeat(2);
  const out = await validateAndRepair({
    reply: longReply,
    config: { maxResponseLength: 300, escalationContacts: [{ name: 'المالك' }] },
    customerText: 'أبي أكلم المدير',
    matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.match(out, /\[تحويل:/, 'يجب أن تبقى علامة التصعيد بعد فرض الطول');
});

test('validateAndRepair: short reply with escalation tag is not affected (I1 regression)', async () => {
  const out = await validateAndRepair({
    reply: 'تمام، سأحوّلك للمالك.',
    config: { maxResponseLength: 300, escalationContacts: [{ name: 'المالك' }] },
    customerText: 'أبي أكلم المدير',
    matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.match(out, /\[تحويل:/, 'علامة التصعيد موجودة في الرد القصير');
});

test('validateAndRepair: long reply without escalation intent is trimmed normally (I1 regression)', async () => {
  const longReply = 'الجملة الأولى قصيرة. ' + 'هذه جملة طويلة جداً تتجاوز الحد المسموح به للطول وتحتوي على تفاصيل كثيرة جداً لا داعي لها في الرد النهائي. '.repeat(3);
  const out = await validateAndRepair({
    reply: longReply,
    config: { maxResponseLength: 100, escalationContacts: [{ name: 'المالك' }] },
    customerText: 'وش عندكم قهوة؟',
    matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.ok(out.length <= 105, `الرد يجب أن يكون أقصر من الحد، got length=${out.length}`);
  assert.ok(!out.includes('[تحويل:'), 'لا يجب أن تكون علامة تصعيد لأن النية غير موجودة');
});

const { stripStyleViolations } = require('../src/services/ai/reply-validator');

test('stripStyleViolations removes "كيف أقدر أساعدك" variants', () => {
  assert.equal(stripStyleViolations('وعليكم السلام! كيف أقدر أساعدك اليوم؟').includes('أساعدك'), false);
  assert.equal(stripStyleViolations('هلا! كيف أقدر أخدمك اليوم؟').includes('أخدمك'), false);
  assert.equal(stripStyleViolations('أهلين، كيف يمكنني مساعدتك؟').includes('مساعدتك'), false);
});
test('stripStyleViolations keeps normal content intact', () => {
  const r = 'الشحن يوصل خلال يومين عبر سمسا';
  assert.equal(stripStyleViolations(r), r);
});
test('stripStyleViolations leaves a clean greeting when offer-help removed', () => {
  const out = stripStyleViolations('وعليكم السلام! كيف أقدر أخدمك اليوم؟');
  assert.ok(out.startsWith('وعليكم السلام'));
  assert.ok(out.length > 0);
});

test('validateAndRepair strips offer-help phrase deterministically', async () => {
  const out = await validateAndRepair({
    reply: 'وعليكم السلام! كيف أقدر أخدمك اليوم؟',
    config: {}, customerText: 'السلام عليكم', matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.equal(/أخدمك|أساعدك/.test(out), false);
  assert.ok(out.includes('السلام'));
});

const { enforceStyleRules } = require('../src/services/ai/reply-validator');

test('enforceStyleRules: strips emoji only when emojiLevel none', () => {
  assert.equal(enforceStyleRules('أهلين 🌟😊', { replyStyle: { emojiLevel: 'none' } }), 'أهلين');
  assert.equal(enforceStyleRules('أهلين 🌟', { replyStyle: { emojiLevel: 'medium' } }), 'أهلين 🌟');
});
test('enforceStyleRules: strips "!" only when allowExclamation false', () => {
  assert.equal(enforceStyleRules('حياك الله!', { replyStyle: { allowExclamation: false } }), 'حياك الله');
  assert.equal(enforceStyleRules('حياك الله!', { replyStyle: {} }), 'حياك الله!');
});
test('enforceStyleRules: strips sentence-ending periods when allowSentencePeriods false', () => {
  const cfg = { replyStyle: { allowSentencePeriods: false } };
  assert.equal(enforceStyleRules('السعر 59 ريال. التسليم دعوة.', cfg), 'السعر 59 ريال التسليم دعوة');
  // لا يمسّ النقطة العشرية ولا الروابط
  assert.equal(enforceStyleRules('النسخة 3.5 على prostoree.com', cfg), 'النسخة 3.5 على prostoree.com');
});
test('enforceStyleRules: defaults preserve everything (no merchant choice = no change)', () => {
  const r = 'مرحبا! السعر 59 ريال. 🌟';
  assert.equal(enforceStyleRules(r, { replyStyle: {} }), r);
  assert.equal(enforceStyleRules(r, {}), r);
});

test('validateAndRepair enforces merchant style choices', async () => {
  const out = await validateAndRepair({
    reply: 'حياك الله! السعر 59 ريال. 🌟',
    config: { replyStyle: { emojiLevel: 'none', allowExclamation: false, allowSentencePeriods: false } },
    customerText: 'كم السعر', matched: [],
    regenerate: async () => { throw new Error('no'); },
  });
  assert.equal(/[!🌟]/.test(out), false, 'لا تعجب ولا إيموجي');
  assert.equal(/ريال\./.test(out), false, 'لا نقطة بعد ريال');
  assert.ok(out.includes('59 ريال'));
});
