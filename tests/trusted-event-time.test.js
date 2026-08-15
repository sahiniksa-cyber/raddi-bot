'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TRUSTED_SLA_SOURCES,
  resolveTrustedEventTimestamp,
} = require('../src/services/ai/trusted-event-time');

test('message_created_at is NOT a trusted SLA source (never treated as order time)', () => {
  assert.equal(TRUSTED_SLA_SOURCES.includes('message_created_at'), false);
});

test('resolves the highest-priority available trusted timestamp', () => {
  const order = new Date('2026-08-10T00:00:00Z');
  const esc = new Date('2026-08-14T00:00:00Z');
  const r = resolveTrustedEventTimestamp({
    order_created_at: order,
    escalation_thread_created_at: esc,
  });
  assert.equal(r.source, 'order_created_at'); // order outranks escalation-thread
  assert.equal(r.timestamp.getTime(), order.getTime());
});

test('falls through to the next source when higher-priority ones are absent', () => {
  const esc = new Date('2026-08-14T00:00:00Z');
  const r = resolveTrustedEventTimestamp({ escalation_thread_created_at: esc });
  assert.equal(r.source, 'escalation_thread_created_at');
  assert.equal(r.timestamp.getTime(), esc.getTime());
});

test('no trusted source present → null (SLA must NOT be claimed / no invented time)', () => {
  assert.equal(resolveTrustedEventTimestamp({}), null);
  assert.equal(resolveTrustedEventTimestamp({ message_created_at: new Date() }), null);
  assert.equal(resolveTrustedEventTimestamp(null), null);
});

test('ignores unknown / non-trusted keys', () => {
  const r = resolveTrustedEventTimestamp({ random_key: new Date(), payment_created_at: new Date('2026-08-12T00:00:00Z') });
  assert.equal(r.source, 'payment_created_at');
});
