'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scaledMaxLength } = require('../src/services/ai/reply-validator');

test('flag OFF → legacy 3x scaling preserved', () => {
  const prev = process.env.BREVITY_AUTHORITY_ENABLED;
  delete process.env.BREVITY_AUTHORITY_ENABLED;
  try {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 300);
  } finally { if (prev !== undefined) process.env.BREVITY_AUTHORITY_ENABLED = prev; }
});

test('flag ON → multiplier capped at 2x; single question stays 1x', () => {
  const prev = process.env.BREVITY_AUTHORITY_ENABLED;
  process.env.BREVITY_AUTHORITY_ENABLED = 'true';
  try {
    assert.strictEqual(scaledMaxLength(100, 'س؟ س؟ س؟'), 200);
    assert.strictEqual(scaledMaxLength(100, 'سؤال واحد؟'), 100);
  } finally { if (prev === undefined) delete process.env.BREVITY_AUTHORITY_ENABLED; else process.env.BREVITY_AUTHORITY_ENABLED = prev; }
});
