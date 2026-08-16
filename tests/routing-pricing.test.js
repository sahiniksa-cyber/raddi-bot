'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeInstruction } = require('../src/services/instruction-routing/instruction-router');
const { applyRoutingDecision } = require('../src/services/instruction-routing/routing-apply');

// A clear fee/pricing instruction from a merchant edit must become a STRUCTURED
// pricing rule (not sit as free text in botInstructions).
test('routeInstruction routes a clear fee instruction to the pricingRule sink', () => {
  const d = routeInstruction({ category: 'POLICY', confidence: 0.9, line: 'طريقة الدفع Y عليها رسوم 10%' }, {});
  assert.equal(d.sink, 'pricingRule');
  assert.equal(d.rule.type, 'percentage_addition');
  assert.equal(d.rule.value, 10);
  assert.equal(d.rule.trigger, 'Y');
});

test('a non-pricing policy line is NOT captured as a pricing rule', () => {
  const d = routeInstruction({ category: 'POLICY', confidence: 0.9, line: 'ما نبيع منتجات مستعملة' }, {});
  assert.notEqual(d.sink, 'pricingRule');
});

test('applyRoutingDecision stores a pricing rule into structured config.pricingRules (non-destructive append)', () => {
  const d = routeInstruction({ category: 'POLICY', confidence: 0.9, line: 'خصم 15% عند Q' }, {});
  const applied = applyRoutingDecision(d, { pricingRules: [{ type: 'percentage_addition', value: 5, trigger: 'X' }] });
  assert.equal(applied.stored, true);
  assert.equal(applied.field, 'pricingRules');
  assert.equal(applied.value.length, 2, 'appends, keeps the existing rule');
  const added = applied.value[1];
  assert.equal(added.type, 'percentage_discount');
  assert.equal(added.value, 15);
  assert.equal(added.trigger, 'Q');
  assert.equal(added.source, 'merchant_instruction');
});
