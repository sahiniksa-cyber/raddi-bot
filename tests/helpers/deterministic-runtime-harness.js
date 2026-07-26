'use strict';

const { compileMerchantPolicy } = require('../../src/policy/merchant-policy-compiler');
const { createWhatsAppSendGateway } = require('../../src/services/whatsapp/whatsapp-send-gateway');
const { PLATFORM_REPLY_POLICY } = require('../../src/policy/platform-reply-policy');
const { policy: basePolicy } = require('./send-gateway-harness');

function merchantPolicy({ productName = null, priceMinor = null } = {}) {
  const value = JSON.parse(JSON.stringify(basePolicy().policy));
  delete value.policyVersion;
  if (productName) {
    value.catalog.products = [{
      id: 'product-1',
      name: productName,
      aliases: [],
      description: '',
      links: [],
      attributes: {},
      variants: [{
        id: 'variant-1',
        name: 'Standard',
        price: priceMinor === null ? null : { amountMinor: priceMinor, currency: 'SAR' },
        duration: null,
        availability: null,
        attributes: {},
      }],
    }];
  }
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createHarness({
  policies = new Map(),
  destinationOwners = new Map(),
  failureAt = null,
  transportHook = null,
} = {}) {
  const reservations = new Map();
  const audit = [];
  const sends = [];
  const fail = stage => {
    if (failureAt === stage) throw new Error(`INJECTED_${stage}`);
  };

  const auditStore = {
    append: async event => {
      fail(`audit:${event.stage}`);
      audit.push({ ...event, sequence: audit.length + 1 });
      return audit.at(-1);
    },
    reserveSend: async args => {
      fail('reservation');
      const key = `${args.userId}:${args.idempotencyKey}`;
      const existing = reservations.get(key);
      if (existing && existing.status !== 'retryable') {
        return { reserved: false, reservation: { ...existing } };
      }
      const reservation = { ...args, status: 'reserved' };
      reservations.set(key, reservation);
      return { reserved: true, reservation: { ...reservation } };
    },
    markReservation: async args => {
      fail(`mark:${args.status}`);
      const key = `${args.userId}:${args.idempotencyKey}`;
      const current = reservations.get(key);
      if (!current) throw new Error('RESERVATION_MISSING');
      const next = { ...current, ...args };
      reservations.set(key, next);
      return { ...next };
    },
  };

  const gateway = createWhatsAppSendGateway({
    auditStore,
    platformPolicy: PLATFORM_REPLY_POLICY,
    policyStore: {
      loadMerchantPolicy: async userId => {
        fail('policy');
        return policies.get(userId) || null;
      },
    },
    scopeStore: {
      assertSendScope: async request => {
        fail('scope');
        const owner = destinationOwners.get(request.destination);
        if (owner && owner !== request.userId) throw new Error('DESTINATION_SCOPE_MISMATCH');
        return true;
      },
    },
    transport: {
      send: async request => {
        fail('transport');
        if (transportHook) await transportHook(request);
        sends.push({ ...request });
        return { providerMessageId: `provider-${sends.length}` };
      },
    },
  });

  return { audit, gateway, reservations, sends };
}

function compiledPolicy(value) {
  const compiled = compileMerchantPolicy(value);
  if (!compiled.ok) throw new Error('invalid test policy');
  return compiled;
}

function automatedRequest({
  userId,
  destination,
  policyVersion,
  idempotencyKey,
  correlationId = idempotencyKey,
  content = 'Hello',
  customerText = 'Hello',
  conversationFocus = { topics: ['greeting'], evidenceRefs: [] },
}) {
  return {
    sendClass: 'automated_customer_reply',
    userId,
    channelId: 'whatsapp',
    destination,
    conversationId: `conversation-${userId}-${destination}`,
    customerId: destination.split('@')[0],
    messageId: `message-${idempotencyKey}`,
    idempotencyKey,
    correlationId,
    content,
    contentOrigin: 'ai',
    policyVersion,
    tenantScope: { userId },
    customerText,
    conversationFocus,
  };
}

module.exports = {
  automatedRequest,
  compiledPolicy,
  createHarness,
  deferred,
  merchantPolicy,
};
