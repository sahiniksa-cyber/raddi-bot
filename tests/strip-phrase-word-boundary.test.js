'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAvoidedContent } = require('../lib/post-process-reply');

// Regression for the "ويتواصل معك الـ قريباً" artifact seen in production: an
// avoided single word ("فريق") was removed as a raw substring, so it also ate
// the same letters inside the larger word "الفريق", leaving the broken "ال".
test('does not mangle a larger word that merely contains an avoided word as a substring', () => {
  const out = stripAvoidedContent('بسجل طلبك ويتواصل معك الفريق قريباً', {
    replyStyle: { avoidPhrases: ['فريق'] },
  });
  assert.match(out, /الفريق/, 'the word "الفريق" must stay intact');
  assert.doesNotMatch(out, /ال\s+قريبا/, 'must not leave the broken "ال قريباً" fragment');
});

test('still strips an avoided word when it stands alone as a whole word', () => {
  const out = stripAvoidedContent('احنا فريق ممتاز', {
    replyStyle: { avoidPhrases: ['فريق'] },
  });
  assert.doesNotMatch(out, / فريق /, 'the standalone word must be removed');
});

test('does not mangle a word when the avoided word appears as a prefix inside it', () => {
  const out = stripAvoidedContent('هذا فريقنا المختص', {
    replyStyle: { avoidPhrases: ['فريق'] },
  });
  assert.match(out, /فريقنا/, '"فريقنا" must stay intact');
});

test('multi-word avoided phrases keep their existing substring removal behavior', () => {
  const out = stripAvoidedContent('كيف يمكنني مساعدتك اليوم؟', {
    replyStyle: { avoidPhrases: ['كيف يمكنني مساعدتك'] },
  });
  assert.doesNotMatch(out, /كيف يمكنني مساعدتك/, 'the full phrase must be removed');
});
