'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORM_REPLY_POLICY } = require('../../src/policy/platform-reply-policy');
const { harness, request } = require('../helpers/send-gateway-harness');

test('platform alert requires the code-owned platform policy version', async () => {
  const h = harness();
  await assert.rejects(
    h.gateway.send(request({ sendClass: 'platform_alert', policyVersion: 'stale' })),
    /POLICY_VERSION_MISMATCH/,
  );
  const result = await h.gateway.send(request({
    sendClass: 'platform_alert',
    policyVersion: PLATFORM_REPLY_POLICY.policyVersion,
    idempotencyKey: 'alert-1',
  }));
  assert.equal(result.decision, 'sent');
});
