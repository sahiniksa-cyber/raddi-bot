'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { combineCannedAndAi } = require('../src/services/bot/platform-features');

test('strips duplicated leading greeting from the AI part (the reported bug)', () => {
  const out = combineCannedAndAi('وعليكم السلام، حياك الله', 'وعليكم السلام، سعر أدوبي 120 ريال');
  // greeting must appear exactly once
  assert.equal((out.match(/عليكم السلام/g) || []).length, 1);
  assert.match(out, /حياك الله/);
  assert.match(out, /120/);
});

test('keeps AI answer when it does not greet', () => {
  assert.equal(combineCannedAndAi('وعليكم السلام', 'السعر 120 ريال'), 'وعليكم السلام\nالسعر 120 ريال');
});

test('AI that only greets (no extra content) → just the canned greeting (no dup)', () => {
  assert.equal(combineCannedAndAi('وعليكم السلام، حياك الله', 'هلا وعليكم السلام'), 'وعليكم السلام، حياك الله');
});

test('strips an orphan greeting continuation after an instant greeting (reported screenshot)', () => {
  assert.equal(
    combineCannedAndAi('وعليكم السلام، هلا ومرحبا', 'ورحمة الله وبركاته'),
    'وعليكم السلام، هلا ومرحبا',
  );
});

test('no canned prefix → returns AI reply unchanged', () => {
  assert.equal(combineCannedAndAi('', 'السعر 120'), 'السعر 120');
});

test('various greeting forms are stripped', () => {
  for (const g of ['أهلين، ', 'هلا والله ', 'مرحبا ', 'حياك الله ']) {
    const out = combineCannedAndAi('وعليكم السلام', g + 'السعر 50');
    assert.equal(out, 'وعليكم السلام\nالسعر 50', `failed for "${g}"`);
  }
});
