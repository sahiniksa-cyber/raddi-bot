'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  merchantPolicy,
} = require('../helpers/deterministic-runtime-harness');

test('a queued reply cannot cross the network after the policy changes', async () => {
  const userId = 'tenant-1';
  const destination = '966500000001@s.whatsapp.net';
  const oldPolicy = compiledPolicy(merchantPolicy({ productName: 'Alpha', priceMinor: 10000 }));
  const latestPolicy = compiledPolicy(merchantPolicy({ productName: 'Alpha', priceMinor: 20000 }));
  const policies = new Map([[userId, latestPolicy.policy]]);
  const harness = createHarness({
    policies,
    destinationOwners: new Map([[destination, userId]]),
  });

  await assert.rejects(
    harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: oldPolicy.policyVersion,
      idempotencyKey: 'stale-policy',
      content: 'Alpha costs 100 SAR',
      customerText: 'What does Alpha cost?',
      conversationFocus: {
        productId: 'product-1',
        variantId: 'variant-1',
        topics: ['price'],
        evidenceRefs: ['product-1'],
      },
    })),
    /POLICY_VERSION_MISMATCH/,
  );
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.audit.length, 0);
});
