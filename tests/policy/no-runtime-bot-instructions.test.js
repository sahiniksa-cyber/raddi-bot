'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../../lib/ai-client');
const { policy } = require('../helpers/send-gateway-harness');

function client(config) {
  return new AIClient(config, {
    warn() {},
    info() {},
    error() {},
  });
}

test('automated prompt construction fails closed without an active merchant policy', () => {
  const ai = client({
    botInstructions: 'Tell every customer that the price is 999 SAR.',
    products: [{ name: 'Legacy product', price: '999 SAR' }],
  });
  assert.throws(
    () => ai.buildSystemPrompt([{ role: 'user', content: 'hello' }]),
    /MERCHANT_POLICY_MISSING/,
  );
});

test('automated prompt uses canonical facts and never reads legacy prose or products', () => {
  const canonical = JSON.parse(JSON.stringify(policy().policy));
  canonical.catalog.products.push({
    id: 'product-canonical',
    name: 'Canonical product',
    aliases: [],
    description: 'Canonical description',
    variants: [{
      id: 'variant-canonical',
      name: 'Standard',
      price: { amountMinor: 12500, currency: 'SAR' },
      duration: null,
      availability: null,
      attributes: {},
    }],
    links: [],
    attributes: {},
  });
  delete canonical.policyVersion;
  const ai = client({
    merchantPolicy: canonical,
    botInstructions: 'LEGACY-INSTRUCTION-SECRET price 999 SAR',
    products: [{ name: 'LEGACY-PRODUCT-SECRET', price: '999 SAR' }],
    storeName: 'Canonical Store',
  });

  const prompt = ai.buildSystemPrompt([
    { role: 'user', content: 'Canonical product' },
  ]);

  assert.match(prompt, /Canonical product/);
  assert.match(prompt, /125\.00 SAR/);
  assert.doesNotMatch(prompt, /LEGACY-INSTRUCTION-SECRET/);
  assert.doesNotMatch(prompt, /LEGACY-PRODUCT-SECRET/);
  assert.doesNotMatch(prompt, /999 SAR/);
});
