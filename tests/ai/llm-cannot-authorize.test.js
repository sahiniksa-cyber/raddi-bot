'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('an LLM pass verdict cannot authorize an invented contact number', async () => {
  const h = harness({ validator: undefined });
  const result = await h.gateway.send(request({
    policyVersion: h.compiled.policyVersion,
    content: 'تواصل مع خدمة العملاء على 0593216744',
    customerText: 'واجهتني مشكلة',
    llmReview: { decision: 'pass', confidence: 1 },
  }));
  assert.equal(result.decision, 'block');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.events.map(event => event.stage), ['original', 'blocked']);
});

test('an LLM fail verdict cannot replace a deterministic valid reply', async () => {
  const h = harness({ validator: undefined });
  const result = await h.gateway.send(request({
    policyVersion: h.compiled.policyVersion,
    content: 'وعليكم السلام',
    customerText: 'السلام عليكم',
    llmReview: {
      decision: 'fail',
      alternateReply: 'اتصل على 0593216744',
    },
  }));
  assert.equal(result.decision, 'sent');
  assert.equal(h.sends[0].content, 'وعليكم السلام');
});
