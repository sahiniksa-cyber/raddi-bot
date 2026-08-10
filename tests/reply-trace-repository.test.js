'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendReplyStage,
  finishReplyTrace,
  redactTraceValue,
  startReplyTrace,
} = require('../src/services/ai/reply-trace-repository');

function makeDatabase() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          operation_id: params?.[0],
          user_id: params?.[1],
          retention_until: '2026-08-25T00:00:00.000Z',
        }],
      };
    },
  };
}

test('trace redaction removes secrets and unnecessary direct identifiers recursively', () => {
  const clean = redactTraceValue({
    text: 'راسلني user@example.com أو 0551234567 ومفتاح sk-abcdefghijklmnopqrstuvwxyz1234',
    openaiApiKey: 'sk-secret-must-disappear',
    nested: { authorization: 'Bearer secret', safe: 'adobe' },
  });

  const serialized = JSON.stringify(clean);
  assert.doesNotMatch(serialized, /user@example\.com|0551234567|sk-secret|Bearer secret/);
  assert.match(serialized, /\[EMAIL\]|\[PHONE\]|\[SECRET\]/);
  assert.equal(clean.nested.safe, 'adobe');
  assert.equal(clean.openaiApiKey, undefined);
});

test('reply trace writes are always scoped by tenant and retain for 30 days by default', async () => {
  const database = makeDatabase();
  const operationId = 'op-123';

  await startReplyTrace({
    database,
    scope: {
      tenantId: 'tenant-1',
      channelId: 'whatsapp',
      conversationId: 'conv-1',
      customerId: 'customer-1',
    },
    operationId,
    input: {
      customerMessage: 'سعر أدوبي؟',
      inboundMessageId: 'msg-1',
      promptVersion: 'prompt-v4',
      validatorVersion: 'validator-v2',
      catalogVersion: 7,
    },
  });
  await appendReplyStage({
    database,
    tenantId: 'tenant-1',
    operationId,
    stage: { name: 'generated', reply: 'أدوبي 4 أشهر بـ189 ريال', latencyMs: 22 },
  });
  await finishReplyTrace({
    database,
    tenantId: 'tenant-1',
    operationId,
    outcome: { status: 'sent', finalReply: 'أدوبي 4 أشهر بـ189 ريال', reason: 'validated' },
  });

  assert.match(database.calls[0].sql, /INTERVAL '30 days'/);
  assert.match(database.calls[0].sql, /DELETE FROM ai_reply_traces/);
  assert.match(database.calls[0].sql, /retention_until <= NOW\(\)/);
  assert.ok(database.calls.every(call => call.params.includes('tenant-1')));
  assert.match(database.calls[1].sql, /user_id = \$2/);
  assert.match(database.calls[2].sql, /user_id = \$2/);
});

test('trace repository fails before SQL when mandatory scope is incomplete', async () => {
  const database = makeDatabase();
  await assert.rejects(
    startReplyTrace({
      database,
      scope: { tenantId: 'tenant-1', channelId: 'whatsapp' },
      operationId: 'op-bad',
      input: {},
    }),
    /conversationId/,
  );
  assert.equal(database.calls.length, 0);
});
