'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  merchantPolicy,
} = require('../helpers/deterministic-runtime-harness');

test('20 concurrent customers across 4 tenants remain isolated', async () => {
  const policies = new Map();
  const destinationOwners = new Map();
  const requests = [];
  for (let tenantIndex = 1; tenantIndex <= 4; tenantIndex += 1) {
    const userId = `tenant-${tenantIndex}`;
    const compiled = compiledPolicy(merchantPolicy());
    policies.set(userId, compiled.policy);
    for (let customerIndex = 1; customerIndex <= 5; customerIndex += 1) {
      const destination = `9665${tenantIndex}${String(customerIndex).padStart(7, '0')}@s.whatsapp.net`;
      destinationOwners.set(destination, userId);
      requests.push(automatedRequest({
        userId,
        destination,
        policyVersion: compiled.policyVersion,
        idempotencyKey: `${userId}:customer-${customerIndex}`,
      }));
    }
  }
  const harness = createHarness({ policies, destinationOwners });
  const results = await Promise.all(requests.map(request => harness.gateway.send(request)));

  assert.equal(results.every(result => result.decision === 'sent'), true);
  assert.equal(harness.sends.length, 20);
  for (const request of requests) {
    assert.equal(destinationOwners.get(request.destination), request.userId);
    assert.equal(
      harness.audit
        .filter(event => event.correlationId === request.correlationId)
        .every(event => event.userId === request.userId),
      true,
    );
  }
});

test('a tenant cannot send to a destination owned by another tenant', async () => {
  const first = compiledPolicy(merchantPolicy());
  const second = compiledPolicy(merchantPolicy());
  const destination = '966500000099@s.whatsapp.net';
  const harness = createHarness({
    policies: new Map([['tenant-1', first.policy], ['tenant-2', second.policy]]),
    destinationOwners: new Map([[destination, 'tenant-2']]),
  });

  await assert.rejects(
    harness.gateway.send(automatedRequest({
      userId: 'tenant-1',
      destination,
      policyVersion: first.policyVersion,
      idempotencyKey: 'cross-tenant',
    })),
    /DESTINATION_SCOPE_MISMATCH/,
  );
  assert.equal(harness.sends.length, 0);
});
