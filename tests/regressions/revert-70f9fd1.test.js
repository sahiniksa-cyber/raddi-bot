'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripAvoidedContent } = require('../../lib/post-process-reply');
const { validateAutomatedReply } = require('../../src/services/ai/deterministic-reply-validator');
const { compiledPolicy, merchantPolicy } = require('../helpers/deterministic-runtime-harness');
const { PLATFORM_REPLY_POLICY } = require('../../src/policy/platform-reply-policy');

function validate(reply, customerText, conversationFocus) {
  const value = merchantPolicy({
    productName: 'Alpha',
    priceMinor: 10000,
  });
  value.catalog.products.push({
    id: 'product-2',
    name: 'Beta',
    aliases: [],
    description: '',
    links: [],
    attributes: {},
    variants: [{
      id: 'variant-2',
      name: 'Standard',
      price: { amountMinor: 20000, currency: 'SAR' },
      duration: null,
      availability: null,
      attributes: {},
    }],
  });
  return validateAutomatedReply({
    reply,
    customerText,
    conversationFocus,
    compiledPolicy: compiledPolicy(value),
    platformPolicy: PLATFORM_REPLY_POLICY,
  });
}

test('restored protection: removed merchant-forbidden prose is never silently restored', () => {
  const forbidden = 'إذا عندك أي استفسار أنا موجود';
  const result = stripAvoidedContent(
    `تم استلام طلبك. ${forbidden}`,
    { replyStyle: { avoidPhrases: [forbidden] } },
  );
  assert.doesNotMatch(result, /إذا عندك أي استفسار أنا موجود/);
});

test('restored protection: a fully stripped reply cannot restore the forbidden original', () => {
  const forbidden = 'ممنوع بالكامل';
  const result = stripAvoidedContent(
    forbidden,
    { replyStyle: { avoidPhrases: [forbidden] } },
  );
  assert.equal(result, '');
});

test('restored protection: another product fact cannot authorize the focused product', () => {
  const result = validate(
    'Beta costs 100 SAR',
    'What does Beta cost?',
    {
      productId: 'product-2',
      variantId: 'variant-2',
      topics: ['price'],
      evidenceRefs: ['product-2'],
    },
  );
  assert.equal(result.ok, false);
});

test('restored protection: an authorized fact from a stale topic is still off-topic', () => {
  const result = validate(
    'Alpha costs 100 SAR',
    'Is Alpha available?',
    {
      productId: 'product-1',
      variantId: 'variant-1',
      topics: ['availability'],
      evidenceRefs: ['product-1'],
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.some(item => item.code === 'OFF_TOPIC_CURRENT_TURN'), true);
});

test('restored protection: an invented phone and generic advice fail together', () => {
  const result = validate(
    'Call customer service at 0593216744',
    'Hello',
    { topics: ['greeting'], evidenceRefs: [] },
  );
  const codes = result.violations.map(item => item.code);
  assert.equal(codes.includes('UNAUTHORIZED_CONTACT'), true);
  assert.equal(codes.includes('OFF_TOPIC_CURRENT_TURN'), true);
});
