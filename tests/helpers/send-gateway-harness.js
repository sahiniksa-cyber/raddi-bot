'use strict';

const { compileMerchantPolicy } = require('../../src/policy/merchant-policy-compiler');
const { PLATFORM_REPLY_POLICY } = require('../../src/policy/platform-reply-policy');
const {
  createWhatsAppSendGateway,
} = require('../../src/services/whatsapp/whatsapp-send-gateway');

function policy() {
  const compiled = compileMerchantPolicy({
    schemaVersion: 1,
    status: 'active',
    catalog: { products: [] },
    persona: {
      role: 'customer_service_agent',
      displayName: null,
      language: 'ar',
      dialect: 'saudi',
      tone: 'ودود',
      brevity: 'concise',
      formatting: {},
    },
    businessRules: [],
    prohibitions: { words: [], phrases: [], claims: [], destinations: [] },
    routing: { contacts: [], rules: [], pauseAfterHandoff: false },
    instantReplies: [],
    migration: { legacyArchived: {}, reviewItems: [] },
  });
  if (!compiled.ok) throw new Error('fixture policy failed');
  return compiled;
}

function request(overrides = {}) {
  const compiled = policy();
  return {
    sendClass: 'automated_customer_reply',
    userId: '00000000-0000-4000-8000-000000000001',
    channelId: 'whatsapp',
    destination: '966500000001@s.whatsapp.net',
    conversationId: '00000000-0000-4000-8000-000000000002',
    customerId: '966500000001',
    messageId: '00000000-0000-4000-8000-000000000003',
    idempotencyKey: 'reply:3',
    correlationId: '00000000-0000-4000-8000-000000000004',
    content: 'وعليكم السلام',
    contentOrigin: 'ai',
    policyVersion: compiled.policyVersion,
    tenantScope: {
      userId: '00000000-0000-4000-8000-000000000001',
    },
    customerText: 'السلام عليكم',
    conversationFocus: {},
    ...overrides,
  };
}

function harness(overrides = {}) {
  const compiled = policy();
  const events = [];
  const sends = [];
  const deps = {
    auditStore: {
      append: async event => {
        events.push(event);
        return event;
      },
      reserveSend: async args => ({ reserved: true, reservation: args }),
      markReservation: async args => args,
    },
    policyStore: {
      loadMerchantPolicy: async () => compiled.policy,
    },
    scopeStore: {
      assertSendScope: async () => true,
    },
    transport: {
      send: async args => {
        sends.push(args);
        return { providerMessageId: 'provider-1' };
      },
    },
    validator: () => ({ ok: true, evidenceRefs: [], violations: [] }),
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  };
  return {
    compiled,
    deps,
    events,
    gateway: createWhatsAppSendGateway(deps),
    sends,
  };
}

module.exports = { harness, policy, request };
