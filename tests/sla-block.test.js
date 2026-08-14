'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSlaBlock } = require('../src/services/instruction-routing/sla-block');

test('empty / missing → no block', () => {
  assert.equal(buildSlaBlock([]), '');
  assert.equal(buildSlaBlock(null), '');
  assert.equal(buildSlaBlock(undefined), '');
});

test('renders each SLA policy as an authoritative time fact', () => {
  const block = buildSlaBlock([
    { amount: 12, unit: 'ساعة', source_text: 'التفعيل خلال 12 ساعة من الدفع' },
    { amount: 3, unit: 'أيام', source_text: 'الشحن خلال 3 أيام' },
  ]);
  assert.match(block, /SLA|الوقت/);
  assert.ok(block.includes('التفعيل خلال 12 ساعة من الدفع'));
  assert.ok(block.includes('الشحن خلال 3 أيام'));
  assert.match(block, /مصدر رسمي|لا تخترع|ثابتة/);
});

test('falls back to amount+unit when source_text is absent', () => {
  const block = buildSlaBlock([{ amount: 24, unit: 'ساعة' }]);
  assert.ok(block.includes('24') && block.includes('ساعة'));
});
