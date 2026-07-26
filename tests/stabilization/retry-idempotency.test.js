'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsAppSendGateway } = require('../../src/services/whatsapp/whatsapp-send-gateway');
const { policy, request } = require('../helpers/send-gateway-harness');

function durableHarness({ failFirstOriginalAudit = false, failTransport = false } = {}) {
  const compiled = policy();
  const reservations = new Map();
  const events = [];
  let originalFailures = failFirstOriginalAudit ? 1 : 0;
  let transportCalls = 0;
  const auditStore = {
    async reserveSend(args) {
      const key = `${args.userId}:${args.idempotencyKey}`;
      const existing = reservations.get(key);
      if (existing && existing.status !== 'retryable') {
        return { reserved: false, reservation: { ...existing } };
      }
      const reservation = { ...args, status: 'reserved', provider_message_id: null };
      reservations.set(key, reservation);
      return { reserved: true, reservation: { ...reservation } };
    },
    async markReservation({ userId, idempotencyKey, status, providerMessageId = null }) {
      const key = `${userId}:${idempotencyKey}`;
      const current = reservations.get(key);
      if (!current) throw new Error('reservation missing');
      Object.assign(current, { status, provider_message_id: providerMessageId });
      return { ...current };
    },
    async append(event) {
      if (event.stage === 'original' && originalFailures > 0) {
        originalFailures -= 1;
        throw new Error('audit unavailable');
      }
      events.push(event);
      return event;
    },
  };
  const gateway = createWhatsAppSendGateway({
    auditStore,
    policyStore: { loadMerchantPolicy: async () => compiled.policy },
    scopeStore: { assertSendScope: async () => true },
    transport: {
      async send() {
        transportCalls += 1;
        if (failTransport) throw new Error('provider timeout');
        return { providerMessageId: 'provider-1' };
      },
    },
    validator: () => ({ ok: true, evidenceRefs: [], violations: [] }),
  });
  return {
    events,
    gateway,
    reservations,
    transportCalls: () => transportCalls,
  };
}

test('pre-network failure releases the durable reservation for a safe retry', async () => {
  const h = durableHarness({ failFirstOriginalAudit: true });
  const envelope = request();
  await assert.rejects(h.gateway.send(envelope), /audit unavailable/);
  assert.equal(h.transportCalls(), 0);
  const retried = await h.gateway.send(envelope);
  assert.equal(retried.decision, 'sent');
  assert.equal(h.transportCalls(), 1);
});

test('transport ambiguity is held and retry cannot create a duplicate network send', async () => {
  const h = durableHarness({ failTransport: true });
  const envelope = request();
  await assert.rejects(h.gateway.send(envelope), /provider timeout/);
  assert.equal(h.transportCalls(), 1);
  const retried = await h.gateway.send(envelope);
  assert.equal(retried.decision, 'held');
  assert.equal(h.transportCalls(), 1);
});

test('successful provider id is durably finalized before returning', async () => {
  const h = durableHarness();
  const envelope = request();
  const result = await h.gateway.send(envelope);
  assert.equal(result.decision, 'sent');
  const reservation = [...h.reservations.values()][0];
  assert.equal(reservation.status, 'sent');
  assert.equal(reservation.provider_message_id, 'provider-1');
});
