'use strict';

// Legacy-path regression lock: asserts the CURRENT (default) prompt wording.
// Pin the style/brevity flags OFF so this file deterministically tests the
// legacy path regardless of ambient env. New-path behavior is locked in
// tests/reply-voice-newpath-locks.test.js.
process.env.PROMPT_STYLE_SPLIT_ENABLED = "false";
delete process.env.BREVITY_AUTHORITY_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateAndRepair, scaledMaxLength } = require('../src/services/ai/reply-validator');
const { combineCannedAndAi } = require('../src/services/bot/platform-features');
const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');
const { isLearnablePair } = require('../src/services/learning/owner-reply-learner');

// ── Root 1 (production 2026-06-11, conv 95d06a33): merchant caps replies at
// 100 chars; a message carrying a greeting + a real question (or 2-3
// questions) got truncated down to just the greeting.

test('scaledMaxLength grows the cap with the number of question signals (capped at 2x by default)', () => {
  assert.equal(scaledMaxLength(100, 'سؤال واحد فقط؟'), 100);
  assert.equal(scaledMaxLength(100, 'كم السعر؟ ومتى التوصيل؟'), 200);
  assert.equal(scaledMaxLength(100, 'سؤال؟ وثاني؟ وثالث؟ ورابع؟ وخامس؟'), 200, 'capped at 2x (platform default §6)');
  assert.equal(scaledMaxLength(100, 'بدون علامات لكن رسائل العميل المتتالية. أجب عليها كلها'), 200, 'batched multi-message prompt counts');
});

test('validateAndRepair keeps a full multi-question answer instead of cutting after the greeting', async () => {
  const longAnswer = 'يـ هلا ومرحبا.\nلتفعيل كانفا برو ادخل على الرابط المرسل لك وسجل بنفس الإيميل، بعدها اضغط انضمام للفريق وراح تتفعل كل مزايا برو عندك مباشرة. إذا ما اشتغلت سوّي تسجيل خروج ودخول.';
  const result = await validateAndRepair({
    reply: longAnswer,
    config: { maxResponseLength: 100 },
    customerText: 'السلام عليكم دوبي دخلت كانفا لسى الاشياء البرو م انفتحت كيف افعله ؟ وهل يحتاج ايميل جديد ؟',
    matched: [],
  });
  assert.ok(result.includes('انضمام للفريق'), `answer body must survive: got "${result}"`);
});

// ── Root 2: the AI mimics the merchant greeting with a tatweel ("يـ هلا")
// which the greeting-stripper missed → double greeting in the final reply.

test('combineCannedAndAi strips a tatweel greeting (يـ هلا) from the AI part', () => {
  const out = combineCannedAndAi('وعليكم السلام يـ هلا ومرحبا', 'يـ هلا ومرحبا');
  assert.equal(out, 'وعليكم السلام يـ هلا ومرحبا', 'AI greeting-only reply must collapse into the canned one');
  const out2 = combineCannedAndAi('وعليكم السلام يـ هلا ومرحبا', 'يـ هلا ومرحبا\nتفعيل كانفا برو يكون من الرابط');
  assert.equal(out2, 'وعليكم السلام يـ هلا ومرحبا\nتفعيل كانفا برو يكون من الرابط');
});

// ── Root 3: zero-score learned entries were injected into EVERY reply via the
// medium-set fallback — a learned verification code got sent to the wrong
// customer ("تمام" → "سم هذا كود التحقق").

test('learned entries are injected ONLY when they actually match the customer text', () => {
  // The polluted entry FIRST so the legacy zero-score fallbacks would have
  // included it (small-set "inject all" / medium-set "top scored").
  const learned = [
    { keyword: 'الله يعطيك العافيه تم', reply: 'سم هذا كود التحقق : 2354' },
    { keyword: 'سؤال قديم عن الايميل', reply: 'جواب قديم' },
  ];
  const config = { autoReplyKeywords: { 'الشحن': 'الشحن مجاني فوق 200' }, learnedReplies: learned };

  const result = retrieveRelevantPolicies(config, 'تمام');
  assert.ok(!result.block.includes('كود التحقق'), `unrelated learned entries must NOT be injected: "${result.block}"`);

  // But a learned entry that genuinely matches still injects:
  const matched = retrieveRelevantPolicies(
    { learnedReplies: [{ keyword: 'كيف افعل كانفا برو؟', reply: 'تدخل الرابط وتسجل بنفس الايميل' }] },
    'كيف افعل كانفا برو عندي',
  );
  assert.ok(matched.block.includes('تدخل الرابط'));
});

// ── Root 4: learning quality — conversational fragments and codes must never
// be learned in the first place (the production pollution source).

test('isLearnablePair requires a question-looking question and rejects code answers', () => {
  assert.equal(isLearnablePair('الله يعطيك العافيه تمام احسنت', 'سم هذا كود التحقق : 2354'), false, 'verification code answer');
  assert.equal(isLearnablePair('اوه فهمت عليك الحين تمام', 'عادي بنفس ايميلك الشهر'), false, 'statement, not a question');
  assert.equal(isLearnablePair('كم يستغرق الشحن للرياض؟', 'يومين عمل وبرسوم 25 ريال'), true, 'real question stays learnable');
  assert.equal(isLearnablePair('ابي اعرف طريقة تفعيل كانفا برو', 'تدخل الرابط وتسجل بنفس الايميل'), true, 'question token without ؟ stays learnable');
});
