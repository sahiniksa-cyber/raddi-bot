'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAutomatedReply,
} = require('../../src/services/ai/deterministic-reply-validator');
const {
  compileMerchantPolicy,
} = require('../../src/policy/merchant-policy-compiler');
const {
  PLATFORM_REPLY_POLICY,
} = require('../../src/policy/platform-reply-policy');

function compiledPolicy() {
  const result = compileMerchantPolicy({
    schemaVersion: 1,
    status: 'active',
    catalog: {
      products: [
        {
          id: 'product-alpha',
          name: 'باقة ألف',
          aliases: ['ألف'],
          description: '',
          variants: [
            {
              id: 'variant-alpha',
              name: 'الأساسية',
              price: { amountMinor: 10000, currency: 'SAR' },
              duration: null,
              availability: null,
              attributes: { warranty: 'ضمان لمدة سنة' },
            },
          ],
          links: [],
          attributes: {},
        },
      ],
    },
    persona: {
      role: 'customer_service_agent',
      displayName: null,
      language: 'ar',
      dialect: 'saudi',
      tone: 'ودود',
      brevity: 'concise',
      formatting: {},
    },
    businessRules: [],
    prohibitions: { words: [], phrases: [], claims: [], destinations: [] },
    routing: {
      contacts: [
        {
          id: 'contact-owner',
          name: 'المالك',
          phoneNumber: '+966500000000',
        },
      ],
      rules: [],
      pauseAfterHandoff: false,
    },
    instantReplies: [],
    migration: { legacyArchived: {}, reviewItems: [] },
  });
  assert.equal(result.ok, true);
  return result;
}

function validate({ customerText, conversationFocus, reply }) {
  return validateAutomatedReply({
    customerText,
    conversationFocus,
    reply,
    compiledPolicy: compiledPolicy(),
    platformPolicy: PLATFORM_REPLY_POLICY,
  });
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

test('the reported generic wrong-number advice is off-topic and its contact is unauthorized', () => {
  const result = validate({
    customerText: 'السلام عليكم',
    conversationFocus: { topics: ['greeting'], evidenceRefs: [] },
    reply: 'وعليكم السلام، أعد إدخال الرقم وإذا استمرت المشكلة تواصل مع خدمة العملاء على 0593216744',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('OFF_TOPIC_CURRENT_TURN'), true);
  assert.equal(codes(result).includes('UNAUTHORIZED_CONTACT'), true);
});

test('exact evidence from a stale topic is still rejected for the current turn', () => {
  const result = validate({
    customerText: 'كم سعر باقة ألف؟',
    conversationFocus: {
      productId: 'product-alpha',
      variantId: 'variant-alpha',
      topics: ['price'],
      evidenceRefs: ['product-alpha'],
    },
    reply: 'باقة ألف تشمل ضمان لمدة سنة',
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).includes('OFF_TOPIC_CURRENT_TURN'), true);
  assert.equal(codes(result).includes('UNSUPPORTED_WARRANTY'), false);
});

test('the same exact fact passes when it answers the current topic', () => {
  const result = validate({
    customerText: 'ما ضمان باقة ألف؟',
    conversationFocus: {
      productId: 'product-alpha',
      variantId: 'variant-alpha',
      topics: ['warranty'],
      evidenceRefs: ['product-alpha'],
    },
    reply: 'باقة ألف تشمل ضمان لمدة سنة',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});
