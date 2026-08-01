'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cleanupFinalReplyDeterministically } = require('../src/services/ai/reply-quality-gate');

function withFlag(on, fn) {
  const prev = process.env.CLEAN_LINE_BREAKS_ENABLED;
  if (on) process.env.CLEAN_LINE_BREAKS_ENABLED = 'true';
  else delete process.env.CLEAN_LINE_BREAKS_ENABLED;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLEAN_LINE_BREAKS_ENABLED;
    else process.env.CLEAN_LINE_BREAKS_ENABLED = prev;
  }
}

test('flag ON → blank-line spacing survives the pre-send cleanup', () => {
  withFlag(true, () => {
    const input = 'اشتراك أوفيس مدى الحياة\n\nموجود عندنا وسعره 39 ريال\n\nالاشتراك مضمون وما يقفل';
    const out = cleanupFinalReplyDeterministically(input);
    assert.ok(out.includes('\n\n'), 'blank lines must be preserved');
    assert.strictEqual(out, input);
  });
});

test('flag ON → still dedups repeated lines (no runaway gaps)', () => {
  withFlag(true, () => {
    const input = 'سطر مكرر\n\nسطر مكرر\n\nسطر جديد';
    const out = cleanupFinalReplyDeterministically(input);
    assert.strictEqual((out.match(/سطر مكرر/g) || []).length, 1, 'duplicate removed');
    assert.ok(out.includes('سطر جديد'), 'new line kept');
    assert.ok(!/\n{4,}/.test(out), 'gaps capped, no runaway');
  });
});

test('flag ON → caps consecutive blanks at 2 (no runaway gaps)', () => {
  withFlag(true, () => {
    const out = cleanupFinalReplyDeterministically('أول\n\n\n\n\nثاني');
    assert.ok(!/\n{4,}/.test(out), 'no more than 2 blank lines');
  });
});

test('flag OFF → legacy behavior (blank lines stripped)', () => {
  withFlag(false, () => {
    const out = cleanupFinalReplyDeterministically('أول\n\nثاني');
    assert.strictEqual(out, 'أول\nثاني');
  });
});
