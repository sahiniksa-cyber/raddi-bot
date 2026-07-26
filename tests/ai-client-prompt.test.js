'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');
const { policy } = require('./helpers/send-gateway-harness');

function makeClient(mutator = value => value) {
  const canonical = JSON.parse(JSON.stringify(policy().policy));
  delete canonical.policyVersion;
  mutator(canonical);
  return new AIClient(
    {
      merchantPolicy: canonical,
      storeName: 'LEGACY-STORE-NAME',
      welcomeMessage: 'LEGACY-WELCOME',
      products: [{ name: 'LEGACY-PRODUCT', price: '999 SAR' }],
    },
    { info() {}, warn() {}, error() {} },
  );
}

test('buildSystemPrompt includes canonical persona and policy version', () => {
  const ai = makeClient(canonical => {
    canonical.persona.displayName = 'موظف المتجر';
    canonical.persona.tone = 'ودود ومختصر';
  });
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }]);
  assert.match(prompt, /موظف المتجر/);
  assert.match(prompt, /ودود ومختصر/);
  assert.match(prompt, /policyVersion: sha256:/);
});

test('buildSystemPrompt excludes legacy store, welcome, and product fields', () => {
  const prompt = makeClient().buildSystemPrompt([], { isFirstMsg: true });
  assert.doesNotMatch(prompt, /LEGACY-STORE-NAME/);
  assert.doesNotMatch(prompt, /LEGACY-WELCOME/);
  assert.doesNotMatch(prompt, /LEGACY-PRODUCT/);
  assert.doesNotMatch(prompt, /999 SAR/);
});

test('AIClient integrates stripAvoidedContent in getReply', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.match(src, /stripAvoidedContent/);
  assert.match(src, /require\(['"]\.\/post-process-reply['"]\)/);
});
