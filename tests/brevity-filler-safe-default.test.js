'use strict';

// §6 — Brevity & closing-filler stripping are PLATFORM behavior: they must be the
// DEFAULT in code (no reliance on an env flag being switched ON), with an explicit
// kill-switch (=== 'false') for rollback.
const test = require('node:test');
const assert = require('node:assert');
const { scaledMaxLength, stripClosingFiller } = require('../src/services/ai/reply-validator');

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('brevity: UNSET flag → safe 2x cap by default', () => {
  withEnv('BREVITY_AUTHORITY_ENABLED', undefined, () => {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 200, 'default must cap at 2x');
    assert.strictEqual(scaledMaxLength(100, 'سؤال واحد؟'), 100);
  });
});

test('brevity: explicit kill-switch =false → legacy 3x scaling', () => {
  withEnv('BREVITY_AUTHORITY_ENABLED', 'false', () => {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 300);
  });
});

test('filler: UNSET flag → strips trailing filler by default', () => {
  withEnv('CLOSING_FILLER_STRIP_ENABLED', undefined, () => {
    assert.strictEqual(
      stripClosingFiller('السعر 189 ريال إذا عندك أي استفسار ثاني، أنا هنا'),
      'السعر 189 ريال',
    );
  });
});

test('filler: explicit kill-switch =false → no change (rollback)', () => {
  withEnv('CLOSING_FILLER_STRIP_ENABLED', 'false', () => {
    const s = 'السعر 189 ريال إذا عندك أي استفسار ثاني، أنا هنا';
    assert.strictEqual(stripClosingFiller(s), s);
  });
});
