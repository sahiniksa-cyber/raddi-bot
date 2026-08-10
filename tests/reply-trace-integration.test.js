'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reviewOutgoingReplyBeforeSend,
} = require('../src/services/ai/pre-send-review');

test('pre-send review appends the validated final stage to the same scoped operation', async () => {
  const previousFlag = process.env.REPLY_TRACE_ENABLED;
  process.env.REPLY_TRACE_ENABLED = 'true';
  const calls = [];
  const database = {
    isConfigured: () => true,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, content, raw_payload/.test(sql)) {
        return {
          rows: [{
            id: 'reply-1',
            content: 'أدوبي 4 أشهر بـ189 ريال',
            raw_payload: {},
          }],
        };
      }
      if (/SELECT role, direction/.test(sql)) {
        return {
          rows: [{
            id: 'in-1',
            role: 'user',
            direction: 'inbound',
            content: 'كم أدوبي أربعة أشهر؟',
            status: 'queued_for_ai',
            raw_payload: {},
            created_at: new Date().toISOString(),
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const bot = {
    async reviewReplyBeforeSend() {
      return {
        reply: 'أدوبي 4 أشهر بـ189 ريال',
        suppressed: false,
        validationDecision: 'validated',
        finalValidation: {
          decision: 'validated',
          audit: { validatorVersion: 'product-tuples-v1', catalogVersion: 9 },
        },
        audit: { decision: 'pass', confidence: 1 },
      };
    },
  };

  try {
    const result = await reviewOutgoingReplyBeforeSend({
      database,
      bot,
      payload: {
        preSendReviewRequired: true,
        channelId: 'whatsapp',
        customerId: 'customer-1',
        sender: 'customer-1',
        replyOperationId: 'reply-op-1',
      },
      userId: 'tenant-1',
      conversationId: 'conv-1',
      replyMessageId: 'reply-1',
      draft: 'stale queue draft',
    });

    assert.equal(result.reply, 'أدوبي 4 أشهر بـ189 ريال');
    const traceCall = calls.find(call => /UPDATE ai_reply_traces/.test(call.sql));
    assert.ok(traceCall, 'trace stage must be persisted after final validation');
    assert.deepEqual(traceCall.params.slice(0, 2), ['reply-op-1', 'tenant-1']);
    const stage = JSON.parse(traceCall.params[2]);
    assert.equal(stage.name, 'pre_send_review');
    assert.equal(stage.audit.validationDecision, 'validated');
    assert.equal(stage.audit.catalogVersion, 9);
  } finally {
    if (previousFlag == null) delete process.env.REPLY_TRACE_ENABLED;
    else process.env.REPLY_TRACE_ENABLED = previousFlag;
  }
});
