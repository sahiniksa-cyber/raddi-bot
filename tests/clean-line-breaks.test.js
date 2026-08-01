'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyLineBreakFormat } = require('../lib/post-process-reply');

function withFlag(on, fn) {
  const prev = process.env.CLEAN_LINE_BREAKS_ENABLED;
  if (on) process.env.CLEAN_LINE_BREAKS_ENABLED = 'true';
  else delete process.env.CLEAN_LINE_BREAKS_ENABLED;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLEAN_LINE_BREAKS_ENABLED;
    else process.env.CLEAN_LINE_BREAKS_ENABLED = prev;
  }
}

const topic = (count = 2) => ({ replyStyle: { lineBreakMode: 'topic', lineBreakCount: count } });

test('groups a topic together, gaps only between different topics (real example)', () => {
  withFlag(true, () => {
    const input = [
      'وعليكم السلام يـ هلا ومرحبا',
      'اشتراك أدوبي كرييتف كلاود متاح',
      'ومضمون لكامل المدة',
      'اشتراك كانفا برو متاح',
      'ومضمون لمدة سنتين',
      'التفعيل على إيميلك الشخصي',
      'وتوصلك دعوة على الإيميل',
    ].join('\n');
    const expected = [
      'وعليكم السلام يـ هلا ومرحبا',
      'اشتراك أدوبي كرييتف كلاود متاح ومضمون لكامل المدة',
      'اشتراك كانفا برو متاح ومضمون لمدة سنتين',
      'التفعيل على إيميلك الشخصي وتوصلك دعوة على الإيميل',
    ].join('\n\n');
    assert.strictEqual(applyLineBreakFormat(input, topic(2)), expected);
  });
});

test('waw-prefixed line merges into the previous topic (not a new block)', () => {
  withFlag(true, () => {
    const out = applyLineBreakFormat('المنتج متاح\nومضمون سنة كاملة', topic(2));
    assert.strictEqual(out, 'المنتج متاح ومضمون سنة كاملة');
  });
});

test('a line with no connector starts a NEW block (blank line before it)', () => {
  withFlag(true, () => {
    const out = applyLineBreakFormat('اشتراك أدوبي متاح\nاشتراك كانفا متاح', topic(2));
    assert.strictEqual(out, 'اشتراك أدوبي متاح\n\nاشتراك كانفا متاح');
  });
});

test('never breaks a phrase mid-way (كلاً على سطره كتلة واحدة)', () => {
  withFlag(true, () => {
    const out = applyLineBreakFormat('تستفيد من كل المميزات والذكاء الاصطناعي', topic(2));
    assert.ok(!/والذكاء\s*\n/.test(out), 'must not split والذكاء الاصطناعي');
    assert.strictEqual(out.trim(), 'تستفيد من كل المميزات والذكاء الاصطناعي');
  });
});

test('gap size follows the merchant choice (count=3 → two blank lines)', () => {
  withFlag(true, () => {
    const out = applyLineBreakFormat('أدوبي متاح\nكانفا متاح', topic(3));
    assert.strictEqual(out, 'أدوبي متاح\n\n\nكانفا متاح');
  });
});

test('connector words (بس/عشان/ثم) also merge', () => {
  withFlag(true, () => {
    const out = applyLineBreakFormat('الشهري غير متوفر\nعشان يوقف أحياناً', topic(2));
    assert.strictEqual(out, 'الشهري غير متوفر عشان يوقف أحياناً');
  });
});

test('flag OFF → legacy topic behavior unchanged', () => {
  withFlag(false, () => {
    const input = 'واحد اثنان ثلاثة اربعة خمسة ستة سبعة ثمانية تسعة عشرة';
    const out = applyLineBreakFormat(input, { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2, lineBreakWords: 4 } });
    assert.ok(out.includes('\n'), 'legacy word-count path still active when flag off');
  });
});
