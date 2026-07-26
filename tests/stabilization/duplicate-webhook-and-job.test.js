'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  merchantPolicy,
} = require('../helpers/deterministic-runtime-harness');

test('duplicate webhook/job delivery shares a durable provider-derived idempotency key', async () => {
  const userId = 'tenant-1';
  const destination = '966500000001@s.whatsapp.net';
  const compiled = compiledPolicy(merchantPolicy());
  const harness = createHarness({
    policies: new Map([[userId, compiled.policy]]),
    destinationOwners: new Map([[destination, userId]]),
  });
  const request = automatedRequest({
    userId,
    destination,
    policyVersion: compiled.policyVersion,
    idempotencyKey: 'inbound-provider:wamid-123',
  });

  const first = await harness.gateway.send(request);
  const duplicateWebhook = await harness.gateway.send({ ...request, correlationId: 'retry-webhook' });
  const duplicateJob = await harness.gateway.send({ ...request, correlationId: 'retry-job' });

  assert.equal(first.decision, 'sent');
  assert.equal(duplicateWebhook.decision, 'duplicate');
  assert.equal(duplicateJob.decision, 'duplicate');
  assert.equal(harness.sends.length, 1);
});
