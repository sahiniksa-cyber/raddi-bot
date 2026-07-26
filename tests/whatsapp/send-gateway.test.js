'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('authorized automated send audits original and decision before transport', async () => {
  const h = harness();
  const result = await h.gateway.send(request({ policyVersion: h.compiled.policyVersion }));
  assert.equal(result.decision, 'sent');
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.events.map(event => event.stage), ['original', 'authorized', 'sent']);
});

test('missing mandatory request fields fail before transport', async () => {
  for (const field of ['sendClass', 'userId', 'destination', 'idempotencyKey', 'policyVersion']) {
    const h = harness();
    const value = request({ policyVersion: h.compiled.policyVersion });
    delete value[field];
    await assert.rejects(() => h.gateway.send(value));
    assert.equal(h.sends.length, 0, field);
  }
});
