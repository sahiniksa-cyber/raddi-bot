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

test('clean topic mode NEVER breaks mid-phrase (no word-count mangling)', () => {
  withFlag(true, () => {
    // A long unpunctuated phrase (owner disabled periods) must stay intact,
    // NOT get chopped like "والذكاء / الاصطناعي".
    const input = 'عشان تقدر تستفيد من كل المميزات والذكاء الاصطناعي اللي نوفره';
    const out = applyLineBreakFormat(input, { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2 } });
    assert.ok(!/والذكاء\s*\n\s*الاصطناعي/.test(out), 'must not split "والذكاء الاصطناعي"');
    assert.strictEqual(out.trim(), input, 'no natural boundary → stays one clean line');
  });
});

test('clean topic mode breaks on comma + gives a blank-line gap (count=2)', () => {
  withFlag(true, () => {
    const input = 'لا والله ما عندنا برنامج واحد، عندنا أدوبي كامل ويشمل فوتوشوب والإلستريتر';
    const out = applyLineBreakFormat(input, { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2 } });
    assert.match(out, /برنامج واحد،\n\nعندنا أدوبي/, 'break after ، with one blank line');
    assert.ok(!/فوتوشوب\s*\n\s*والإلستريتر/.test(out), 'must not split "فوتوشوب والإلستريتر"');
  });
});

test('gap size is the merchant choice (count=3 → two blank lines)', () => {
  withFlag(true, () => {
    const input = 'السلام عليكم؟ عندنا أدوبي كامل';
    const out = applyLineBreakFormat(input, { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 3 } });
    assert.match(out, /عليكم؟\n\n\nعندنا/, 'count=3 → two blank lines between blocks');
  });
});

test('flag OFF → legacy topic behavior unchanged', () => {
  withFlag(false, () => {
    const input = 'واحد اثنان ثلاثة اربعة خمسة ستة سبعة ثمانية تسعة عشرة';
    const out = applyLineBreakFormat(input, { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2, lineBreakWords: 4 } });
    // legacy path uses the word-count fallback → produces >1 line here
    assert.ok(out.includes('\n'), 'legacy path still active when flag off');
  });
});
