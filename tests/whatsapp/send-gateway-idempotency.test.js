'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('duplicate durable reservation returns duplicate without audit or transport', async () => {
  const h = harness({
    auditStore: {
      append: async event => event,
      reserveSend: async () => ({
        reserved: false,
        reservation: { status: 'reserved', correlation_id: 'existing' },
      }),
    },
  });
  const result = await h.gateway.send(request({ policyVersion: h.compiled.policyVersion }));
  assert.equal(result.decision, 'duplicate');
  assert.equal(h.sends.length, 0);
});

test('policy changed while queued fails closed before reservation and transport', async () => {
  let reserved = 0;
  const h = harness({
    auditStore: {
      append: async event => event,
      reserveSend: async () => {
        reserved += 1;
        return { reserved: true, reservation: {} };
      },
    },
  });
  await assert.rejects(
    () => h.gateway.send(request({ policyVersion: 'sha256:stale' })),
    /POLICY_VERSION_MISMATCH/,
  );
  assert.equal(reserved, 0);
  assert.equal(h.sends.length, 0);
});
