'use strict';

// Regression: in topic mode with CLEAN_LINE_BREAKS_ENABLED, an AI reply that
// arrives as ONE block (model ignored the formatting instruction, comma-only
// Arabic, no periods) used to stay a single wall of text because
// breakByTopicBlocks had no line boundaries to group. It now synthesizes natural
// boundaries (sentence-ends + Arabic commas) first — WITHOUT touching replies
// that already have the model's line breaks, and WITHOUT affecting other modes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLineBreakFormat } = require('../lib/post-process-reply');

const ONE_BLOCK = 'إذا عندك اشتراك فعال عن طريق كانفا، ما تحتاج تشترك مرة ثانية من عندنا، إذا حابب تستفيد من مميزات إضافية وضمان لمدة سنتين ممكن تشترك معنا، والاشتراك يتم على إيميلك الشخصي';

function withCleanFlag(on, fn) {
  const prev = process.env.CLEAN_LINE_BREAKS_ENABLED;
  process.env.CLEAN_LINE_BREAKS_ENABLED = on ? 'true' : 'false';
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLEAN_LINE_BREAKS_ENABLED;
    else process.env.CLEAN_LINE_BREAKS_ENABLED = prev;
  }
}
const cfg = (extra = {}) => ({ replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2, ...extra } });

test('topic + CLEAN: a one-block comma-only reply is broken into topic blocks', () => {
  withCleanFlag(true, () => {
    const out = applyLineBreakFormat(ONE_BLOCK, cfg());
    assert.ok(out.includes('\n'), 'no longer a single wall of text');
    assert.ok(out.split('\n').filter(Boolean).length >= 2, 'produced multiple lines/blocks');
    // content preserved (first and last clauses still present)
    assert.ok(out.includes('كانفا'));
    assert.ok(out.includes('إيميلك الشخصي'));
  });
});

test('topic + CLEAN: a reply the model ALREADY broke into lines is respected (no shattering)', () => {
  withCleanFlag(true, () => {
    const already = 'أهلاً فيك\nالاشتراك يتم على إيميلك الشخصي';
    const out = applyLineBreakFormat(already, cfg());
    // both existing ideas survive; we did not split the second line mid-clause on its internal commas
    assert.ok(out.includes('أهلاً فيك'));
    assert.ok(out.includes('الاشتراك يتم على إيميلك الشخصي'));
  });
});

test('connected mode is NEVER touched (merchant chose one block)', () => {
  withCleanFlag(true, () => {
    const out = applyLineBreakFormat(ONE_BLOCK, { replyStyle: { lineBreakMode: 'connected' } });
    assert.equal(out, ONE_BLOCK, 'connected stays exactly as-is');
  });
});

test('the one-block case also breaks in ai mode (word/sentence fallback still works)', () => {
  const out = applyLineBreakFormat(ONE_BLOCK, { replyStyle: { lineBreakMode: 'ai', lineBreakWords: 12 } });
  assert.ok(out.includes('\n'), 'ai mode still breaks a long block');
});
