'use strict';

const crypto = require('node:crypto');

const { compileMerchantPolicy } = require('../../policy/merchant-policy-compiler');
const { PLATFORM_REPLY_POLICY } = require('../../policy/platform-reply-policy');
const {
  validateAutomatedReply,
} = require('../ai/deterministic-reply-validator');

const SEND_CLASSES = new Set([
  'automated_customer_reply',
  'human_manual_reply',
  'campaign',
  'platform_alert',
  'handoff_notification',
]);
const MERCHANT_CLASSES = new Set([
  'automated_customer_reply',
  'human_manual_reply',
  'campaign',
  'handoff_notification',
]);

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content ?? '')).digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('send request is required');
  if (!SEND_CLASSES.has(request.sendClass)) throw new TypeError('sendClass is invalid');
  requireText(request.userId, 'userId');
  requireText(request.destination, 'destination');
  requireText(request.idempotencyKey, 'idempotencyKey');
  requireText(request.correlationId, 'correlationId');
  requireText(request.policyVersion, 'policyVersion');
  if (!request.tenantScope || typeof request.tenantScope !== 'object') {
    throw new TypeError('tenantScope is required');
  }
  requireText(request.tenantScope.userId, 'tenantScope.userId');
  if (request.tenantScope.userId !== request.userId) {
    throw new Error('TENANT_SCOPE_MISMATCH');
  }
  if (request.channelId !== 'whatsapp') throw new TypeError('channelId must be whatsapp');
  if (typeof request.content !== 'string' || request.content.trim() === '') {
    throw new TypeError('content is required');
  }
  if (request.sendClass === 'automated_customer_reply') {
    requireText(request.conversationId, 'conversationId');
    requireText(request.customerId, 'customerId');
  }
}

function snapshotRequest(request) {
  return Object.freeze({
    ...request,
    tenantScope: request?.tenantScope && typeof request.tenantScope === 'object'
      ? Object.freeze({ ...request.tenantScope })
      : request?.tenantScope,
  });
}

function createWhatsAppSendGateway({
  auditStore,
  policyStore,
  scopeStore,
  transport,
  compilePolicy = compileMerchantPolicy,
  validator = validateAutomatedReply,
  platformPolicy = PLATFORM_REPLY_POLICY,
}) {
  if (!auditStore
      || typeof auditStore.append !== 'function'
      || typeof auditStore.reserveSend !== 'function') {
    throw new TypeError('append-only auditStore is required');
  }
  if (!policyStore || typeof policyStore.loadMerchantPolicy !== 'function') {
    throw new TypeError('policyStore is required');
  }
  if (!scopeStore || typeof scopeStore.assertSendScope !== 'function') {
    throw new TypeError('scopeStore is required');
  }
  if (!transport || typeof transport.send !== 'function') {
    throw new TypeError('transport is required');
  }

  async function append(request, stage, metadata = {}, violations = [], evidenceRefs = []) {
    return auditStore.append({
      correlationId: request.correlationId,
      userId: request.userId,
      conversationId: request.conversationId || null,
      customerId: request.customerId || null,
      destination: request.destination,
      sendClass: request.sendClass,
      stage,
      policyVersion: request.policyVersion,
      content: request.content,
      contentHash: contentHash(request.content),
      evidenceRefs,
      violations,
      metadata,
    });
  }

  async function send(request) {
    const envelope = snapshotRequest(request);
    validateRequest(envelope);
    await scopeStore.assertSendScope(envelope);

    let compiledPolicy = null;
    if (MERCHANT_CLASSES.has(envelope.sendClass)) {
      const policy = await policyStore.loadMerchantPolicy(envelope.userId);
      if (!policy) throw new Error('POLICY_MISSING');
      compiledPolicy = compilePolicy(policy);
      if (!compiledPolicy?.ok || compiledPolicy.policy?.status !== 'active') {
        throw new Error('POLICY_INVALID');
      }
      if (compiledPolicy.policyVersion !== envelope.policyVersion) {
        throw new Error('POLICY_VERSION_MISMATCH');
      }
    } else if (envelope.policyVersion !== platformPolicy.policyVersion) {
      throw new Error('POLICY_VERSION_MISMATCH');
    }

    const reservation = await auditStore.reserveSend({
      userId: envelope.userId,
      idempotencyKey: envelope.idempotencyKey,
      correlationId: envelope.correlationId,
      destination: envelope.destination,
      policyVersion: envelope.policyVersion,
    });
    if (!reservation.reserved) {
      return { decision: 'duplicate', reservation: reservation.reservation };
    }

    await append(envelope, 'original');

    let validation = { ok: true, evidenceRefs: [], violations: [] };
    if (envelope.sendClass === 'automated_customer_reply') {
      validation = validator({
        customerText: envelope.customerText || '',
        conversationFocus: envelope.conversationFocus || {},
        reply: envelope.content,
        compiledPolicy,
        platformPolicy,
      });
      if (!validation?.ok) {
        await append(
          envelope,
          'blocked',
          { decision: 'block' },
          validation?.violations || [{ code: 'VALIDATION_FAILED' }],
          validation?.evidenceRefs || [],
        );
        return { decision: 'block', validation };
      }
    }

    await append(
      envelope,
      'authorized',
      { decision: 'allow' },
      [],
      validation.evidenceRefs || [],
    );
    const provider = await transport.send({
      destination: envelope.destination,
      content: envelope.content,
      media: envelope.media,
      correlationId: envelope.correlationId,
    });
    await append(envelope, 'sent', {
      providerMessageId: provider?.providerMessageId || null,
    });
    return { decision: 'sent', provider, validation };
  }

  return Object.freeze({ send });
}

module.exports = {
  MERCHANT_CLASSES,
  SEND_CLASSES,
  createWhatsAppSendGateway,
  snapshotRequest,
  validateRequest,
};
