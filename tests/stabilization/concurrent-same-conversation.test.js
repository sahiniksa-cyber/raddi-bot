'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  deferred,
  merchantPolicy,
} = require('../helpers/deterministic-runtime-harness');

test('simultaneous duplicate sends produce exactly one network call without timing sleeps', async () => {
  const userId = 'tenant-1';
  const destination = '966500000001@s.whatsapp.net';
  const compiled = compiledPolicy(merchantPolicy());
  const enteredTransport = deferred();
  const releaseTransport = deferred();
  const harness = createHarness({
    policies: new Map([[userId, compiled.policy]]),
    destinationOwners: new Map([[destination, userId]]),
    transportHook: async () => {
      enteredTransport.resolve();
      await releaseTransport.promise;
    },
  });
  const request = automatedRequest({
    userId,
    destination,
    policyVersion: compiled.policyVersion,
    idempotencyKey: 'same-conversation:1',
  });

  const first = harness.gateway.send(request);
  await enteredTransport.promise;
  const duplicates = await Promise.all(
    Array.from({ length: 24 }, () => harness.gateway.send({ ...request })),
  );
  releaseTransport.resolve();
  const sent = await first;

  assert.equal(sent.decision, 'sent');
  assert.equal(harness.sends.length, 1);
  assert.equal(duplicates.every(result => result.decision === 'held'), true);
});
