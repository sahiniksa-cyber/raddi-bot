'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('every mandatory pre-network dependency failure yields zero sends', async () => {
  const failures = [
    { scopeStore: { assertSendScope: async () => { throw new Error('scope'); } } },
    { policyStore: { loadMerchantPolicy: async () => { throw new Error('db'); } } },
    { compilePolicy: () => { throw new Error('compile'); } },
    { auditStore: {
      append: async () => { throw new Error('audit'); },
      reserveSend: async () => ({ reserved: true, reservation: {} }),
    } },
    { auditStore: {
      append: async event => {
        if (event.stage === 'authorized') throw new Error('final audit');
        return event;
      },
      reserveSend: async () => ({ reserved: true, reservation: {} }),
    } },
    { validator: () => { throw new Error('validator'); } },
  ];
  for (const override of failures) {
    const h = harness(override);
    await assert.rejects(() => h.gateway.send(
      request({ policyVersion: h.compiled.policyVersion }),
    ));
    assert.equal(h.sends.length, 0);
  }
});

test('deterministic rejection is audited and never reaches transport', async () => {
  const h = harness({
    validator: () => ({
      ok: false,
      evidenceRefs: [],
      violations: [{ code: 'UNSUPPORTED_PRODUCT_PRICE' }],
    }),
  });
  const result = await h.gateway.send(request({ policyVersion: h.compiled.policyVersion }));
  assert.equal(result.decision, 'block');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.events.map(event => event.stage), ['original', 'blocked']);
});

test('missing or mismatched tenant scope fails before every dependency and transport', async () => {
  const h = harness();
  await assert.rejects(
    () => h.gateway.send(request({ tenantScope: undefined })),
    /tenantScope is required/,
  );
  await assert.rejects(
    () => h.gateway.send(request({ tenantScope: { userId: 'another-merchant' } })),
    /TENANT_SCOPE_MISMATCH/,
  );
  assert.equal(h.events.length, 0);
  assert.equal(h.sends.length, 0);
});

test('gateway snapshots the envelope before awaiting external dependencies', async () => {
  let releaseScope;
  const scopeWait = new Promise(resolve => {
    releaseScope = resolve;
  });
  const h = harness({
    scopeStore: {
      assertSendScope: async () => scopeWait,
    },
  });
  const envelope = request({ content: 'original immutable reply' });
  const pending = h.gateway.send(envelope);
  envelope.content = 'mutated after invocation';
  envelope.destination = 'attacker@s.whatsapp.net';
  releaseScope();
  await pending;
  assert.equal(h.sends[0].content, 'original immutable reply');
  assert.equal(h.sends[0].destination, '966500000001@s.whatsapp.net');
  assert.equal(h.events[0].content, 'original immutable reply');
});
