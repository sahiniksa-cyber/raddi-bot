'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  merchantPolicy,
} = require('../helpers/deterministic-runtime-harness');

for (const failureAt of [
  'scope',
  'policy',
  'reservation',
  'audit:original',
  'audit:authorized',
  'mark:sending',
]) {
  test(`failure at ${failureAt} is fail-closed before network`, async () => {
    const userId = 'tenant-1';
    const destination = '966500000001@s.whatsapp.net';
    const compiled = compiledPolicy(merchantPolicy());
    const harness = createHarness({
      policies: new Map([[userId, compiled.policy]]),
      destinationOwners: new Map([[destination, userId]]),
      failureAt,
    });

    await assert.rejects(harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `failure:${failureAt}`,
    })));
    assert.equal(harness.sends.length, 0);
  });
}
