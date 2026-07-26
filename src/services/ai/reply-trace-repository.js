'use strict';

const crypto = require('node:crypto');

const SECRET_KEY = /(api.?key|authorization|password|secret|token|cookie|credential|auth.?state)/i;
const SECRET_TEXT = /\b(?:sk-(?:or-|ant-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._~-]{8,})\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?966|00966|0)?5\d{8}(?!\d)/g;
const CARD = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
const MAX_TEXT = 4000;

function redactString(value) {
  return String(value)
    .slice(0, MAX_TEXT)
    .replace(SECRET_TEXT, '[SECRET]')
    .replace(EMAIL, '[EMAIL]')
    .replace(PHONE, '[PHONE]')
    .replace(CARD, '[NUMBER]');
}

function redactTraceValue(value, depth = 0) {
  if (depth > 8 || value == null) return value == null ? value : '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => redactTraceValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const clean = {};
    for (const [key, nested] of Object.entries(value).slice(0, 100)) {
      if (SECRET_KEY.test(key)) continue;
      clean[key] = redactTraceValue(nested, depth + 1);
    }
    return clean;
  }
  return redactString(value);
}

function requireDatabase(database) {
  if (!database || typeof database.query !== 'function') {
    throw new Error('reply trace database is required');
  }
}

function requireScope(scope = {}) {
  for (const key of ['tenantId', 'channelId', 'conversationId', 'customerId']) {
    if (!scope[key]) throw new Error(`${key} is required for reply trace scope`);
  }
  return scope;
}

function requireOperationId(operationId) {
  const value = String(operationId || '').trim();
  if (!value) throw new Error('operationId is required for reply tracing');
  return value.slice(0, 160);
}

function buildReplyOperationId({
  tenantId,
  channelId,
  conversationId,
  customerId,
  inboundMessageId,
  jobId,
}) {
  requireScope({ tenantId, channelId, conversationId, customerId });
  const sourceId = inboundMessageId || jobId;
  if (!sourceId) throw new Error('inboundMessageId or jobId is required for reply operation');
  return `reply-${crypto.createHash('sha256').update([
    tenantId,
    channelId,
    conversationId,
    customerId,
    sourceId,
  ].join('\u001f')).digest('hex').slice(0, 40)}`;
}

function isReplyTraceEnabled() {
  // Additive migration must be applied before enabling this. Rollout turns the
  // flag on in shadow/test first, then progressively in production.
  return process.env.REPLY_TRACE_ENABLED === 'true';
}

async function startReplyTrace({ database, scope, operationId, input = {} }) {
  requireDatabase(database);
  const scoped = requireScope(scope);
  const id = requireOperationId(operationId);
  const clean = redactTraceValue(input);
  return database.query(
    `WITH expired AS (
       DELETE FROM ai_reply_traces
        WHERE operation_id IN (
          SELECT operation_id
            FROM ai_reply_traces
           WHERE retention_until <= NOW()
           ORDER BY retention_until ASC
           LIMIT 1000
        )
     )
     INSERT INTO ai_reply_traces (
       operation_id, user_id, channel_id, conversation_id, customer_id,
       inbound_message_id, customer_message_redacted, selected_product,
       product_context, prompt_version, validator_version, catalog_version,
       retention_until
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8::jsonb, $9::jsonb, $10, $11, $12,
       NOW() + INTERVAL '30 days'
     )
     ON CONFLICT (operation_id) DO NOTHING
     RETURNING operation_id, user_id, retention_until`,
    [
      id,
      scoped.tenantId,
      scoped.channelId,
      scoped.conversationId,
      scoped.customerId,
      clean.inboundMessageId || null,
      clean.customerMessage || '',
      clean.selectedProduct == null ? null : JSON.stringify(clean.selectedProduct),
      JSON.stringify(clean.productContext || []),
      clean.promptVersion || null,
      clean.validatorVersion || null,
      Math.max(0, parseInt(clean.catalogVersion, 10) || 0),
    ],
  );
}

async function appendReplyStage({ database, tenantId, operationId, stage }) {
  requireDatabase(database);
  if (!tenantId) throw new Error('tenantId is required for reply trace stage');
  const id = requireOperationId(operationId);
  const clean = redactTraceValue({
    ...stage,
    recordedAt: stage?.recordedAt || new Date().toISOString(),
  });
  return database.query(
    `UPDATE ai_reply_traces
        SET stages = stages || jsonb_build_array($3::jsonb),
            selected_product = COALESCE($4::jsonb, selected_product),
            product_context = CASE WHEN $5::jsonb = 'null'::jsonb
                                   THEN product_context ELSE $5::jsonb END,
            updated_at = NOW()
      WHERE operation_id = $1
        AND user_id = $2
        AND retention_until > NOW()`,
    [
      id,
      tenantId,
      JSON.stringify(clean),
      clean.selectedProduct == null ? null : JSON.stringify(clean.selectedProduct),
      clean.productContext == null ? 'null' : JSON.stringify(clean.productContext),
    ],
  );
}

async function finishReplyTrace({ database, tenantId, operationId, outcome = {} }) {
  requireDatabase(database);
  if (!tenantId) throw new Error('tenantId is required for reply trace outcome');
  const id = requireOperationId(operationId);
  const clean = redactTraceValue(outcome);
  return database.query(
    `UPDATE ai_reply_traces
        SET outcome_status = $3,
            final_reply_redacted = $4,
            outcome_reason = $5,
            validator_version = COALESCE($6, validator_version),
            catalog_version = CASE WHEN $7 > 0 THEN $7 ELSE catalog_version END,
            finished_at = NOW(),
            updated_at = NOW()
      WHERE operation_id = $1
        AND user_id = $2`,
    [
      id,
      tenantId,
      String(clean.status || 'failed').slice(0, 64),
      clean.finalReply || '',
      String(clean.reason || '').slice(0, 500),
      clean.validatorVersion || null,
      Math.max(0, parseInt(clean.catalogVersion, 10) || 0),
    ],
  );
}

async function pruneExpiredReplyTraces({ database, limit = 1000 }) {
  requireDatabase(database);
  const safeLimit = Math.max(1, Math.min(10000, parseInt(limit, 10) || 1000));
  return database.query(
    `DELETE FROM ai_reply_traces
      WHERE operation_id IN (
        SELECT operation_id FROM ai_reply_traces
         WHERE retention_until <= NOW()
         ORDER BY retention_until ASC
         LIMIT $1
      )`,
    [safeLimit],
  );
}

module.exports = {
  appendReplyStage,
  buildReplyOperationId,
  finishReplyTrace,
  isReplyTraceEnabled,
  pruneExpiredReplyTraces,
  redactTraceValue,
  startReplyTrace,
};
