'use strict';

const crypto = require('node:crypto');

const { createReplyAuditStore } = require('../audit/reply-audit-store');
const { WhatsAppSendGateway } = require('./whatsapp-send-gateway');
const { createWhatsAppTransportAdapter } = require('./whatsapp-transport-adapter');

function stableCorrelationId(value) {
  const bytes = crypto.createHash('sha256').update(String(value), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function createRuntimeWhatsAppSendGateway({
  database,
  client,
  assertSendScope,
  transportTimeoutMs,
}) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('database is required');
  }
  if (typeof assertSendScope !== 'function') {
    throw new TypeError('assertSendScope is required');
  }
  return new WhatsAppSendGateway({
    auditStore: createReplyAuditStore({ database }),
    policyStore: {
      async loadMerchantPolicy(userId) {
        const result = await database.query(
          `SELECT config->'merchantPolicy' AS merchant_policy
             FROM bot_configs
            WHERE user_id = $1
            LIMIT 1`,
          [userId],
        );
        return result.rows[0]?.merchant_policy || null;
      },
    },
    scopeStore: {
      assertSendScope,
    },
    transport: createWhatsAppTransportAdapter({
      client,
      timeoutMs: transportTimeoutMs,
    }),
  });
}

module.exports = {
  createRuntimeWhatsAppSendGateway,
  stableCorrelationId,
};
