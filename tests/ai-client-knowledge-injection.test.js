'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { policy } = require('./helpers/send-gateway-harness');

function client({ mutatePolicy = value => value, ...legacy } = {}) {
  const canonical = JSON.parse(JSON.stringify(policy().policy));
  delete canonical.policyVersion;
  mutatePolicy(canonical);
  return new AIClient({
    merchantPolicy: canonical,
    ...legacy,
  }, { info() {}, warn() {}, error() {} }, { record() {} });
}

test('canonical business rules and instant replies are included with evidence IDs', () => {
  const ai = client({
    mutatePolicy(canonical) {
      canonical.businessRules.push({
        id: 'rule-shipping',
        topic: 'shipping',
        statement: 'الشحن خلال يومين',
      });
      canonical.instantReplies.push({
        id: 'instant-shipping',
        triggers: ['الشحن'],
        reply: 'الشحن خلال يومين',
        evidenceRefs: ['rule-shipping'],
      });
    },
  });
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'متى الشحن؟' }]);
  assert.match(prompt, /\[rule-shipping\]/);
  assert.match(prompt, /\[instant-shipping\]/);
  assert.match(prompt, /الشحن خلال يومين/);
});

test('legacy manual and learned replies never enter automated prompt authority', () => {
  const prompt = client({
    autoReplyKeywords: { shipping: 'LEGACY-MANUAL-SECRET' },
    learnedReplies: [{ keyword: 'shipping', reply: 'LEARNED-SECRET' }],
  }).buildSystemPrompt([{ role: 'user', content: 'shipping' }]);
  assert.doesNotMatch(prompt, /LEGACY-MANUAL-SECRET/);
  assert.doesNotMatch(prompt, /LEARNED-SECRET/);
});

test('already answered text is marked verbatim and cannot be repeated', () => {
  const prompt = client().buildSystemPrompt(
    [{ role: 'user', content: 'السلام عليكم، كم السعر؟' }],
    { instantAnswered: 'وعليكم السلام' },
  );
  assert.match(prompt, /<already_answered_verbatim>/);
  assert.match(prompt, /وعليكم السلام/);
  assert.match(prompt, /لا تكرر هذا الجزء/);
});
