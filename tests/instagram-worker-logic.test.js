'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  shouldGenerateReply,
  shouldBlockSendForQuota,
  alreadySent,
  buildAiConfig,
  processIncoming,
  processOutgoing,
} = require('../src/workers/instagram-worker');

test('alreadySent guards against double-send on retry', () => {
  assert.strictEqual(alreadySent({ status: 'sent' }), true);
  assert.strictEqual(alreadySent({ status: 'sending' }), true);
  assert.strictEqual(alreadySent({ provider_message_id: 'mid.1' }), true);
  assert.strictEqual(alreadySent({ status: 'queued_for_send', provider_message_id: null }), false);
  assert.strictEqual(alreadySent(undefined), false);
});

test('processIncoming answers all queued messages once and marks them answered', async () => {
  const queries = [];
  let enqueued = null;
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("direction='inbound'") && sql.includes("status='queued_for_ai'") && sql.includes('SELECT id')) {
        return { rows: [{ id: 'm1' }, { id: 'm2' }] };
      }
      if (sql.includes('SELECT id, content, status') && sql.includes('idempotency_key')) return { rows: [] };
      if (sql.includes('INSERT INTO instagram_messages')) return { rows: [{ id: 'reply1', content: 'answer', status: 'queued_for_send' }] };
      return { rows: [] };
    },
  };
  class FakeAI { async getReply() { return 'answer'; } }
  const result = await processIncoming(
    { id: 'mid.2', data: { userId: 'u1', conversationId: 'c1', participantId: 'p1' } },
    {
      database,
      resolveInstagramConfig: async () => ({ enabled: true, config: {} }),
      buildInstagramHistory: async () => [{ role: 'user', content: 'one\ntwo' }],
      resolveConfigForAI: async () => ({ openaiApiKey: 'k', model: 'gpt-4o' }),
      AIClient: FakeAI,
      checkMessageQuota: async () => ({ canReply: true }),
      enqueueOutgoingInstagram: async (payload) => { enqueued = payload; },
    },
  );
  assert.equal(result.generated, true);
  assert.equal(enqueued.replyMessageId, 'reply1');
  const answered = queries.find((q) => q.sql.includes("SET status='answered_by_ai'"));
  assert.deepStrictEqual(answered.params, [['m1', 'm2'], 'u1']);
});

test('processIncoming does not generate a second reply when no queued inbound remains', async () => {
  let aiCalls = 0;
  class FakeAI { async getReply() { aiCalls++; return 'answer'; } }
  const result = await processIncoming(
    { id: 'mid.2', data: { userId: 'u1', conversationId: 'c1', participantId: 'p1' } },
    {
      database: { query: async () => ({ rows: [] }) },
      resolveInstagramConfig: async () => ({ enabled: true, config: {} }),
      AIClient: FakeAI,
    },
  );
  assert.equal(result.skipped, 'no_pending_inbound');
  assert.equal(aiCalls, 0);
});

test('processIncoming strips internal WhatsApp escalation markers from Instagram customer replies', async () => {
  let insertedText = null;
  const database = {
    query: async (sql, params) => {
      if (sql.includes("direction='inbound'") && sql.includes("status='queued_for_ai'") && sql.includes('SELECT id')) return { rows: [{ id: 'm1' }] };
      if (sql.includes('SELECT id, content, status') && sql.includes('idempotency_key')) return { rows: [] };
      if (sql.includes('INSERT INTO instagram_messages')) { insertedText = params[3]; return { rows: [{ id: 'r1', content: params[3] }] }; }
      return { rows: [] };
    },
  };
  class FakeAI { async getReply() { return 'أبشر بحولك [تحويل:المالك|طلب خاص]'; } }
  await processIncoming(
    { id: 'm1', data: { userId: 'u1', conversationId: 'c1', participantId: 'p1' } },
    {
      database,
      resolveInstagramConfig: async () => ({ enabled: true, config: {} }),
      buildInstagramHistory: async () => [{ role: 'user', content: 'ساعدني' }],
      resolveConfigForAI: async () => ({ openaiApiKey: 'k', model: 'gpt-4o' }),
      AIClient: FakeAI,
      checkMessageQuota: async () => ({ canReply: true }),
      enqueueOutgoingInstagram: async () => {},
    },
  );
  assert.equal(insertedText, 'أبشر بحولك');
});

test('processIncoming skips generation when a human took over after the job was enqueued', async () => {
  let aiCalls = 0;
  const pausedUpdates = [];
  const database = {
    query: async (sql, params) => {
      if (sql.includes("direction='inbound'") && sql.includes("status='queued_for_ai'") && sql.includes('SELECT id')) return { rows: [{ id: 'm1' }] };
      if (sql.includes('escalated_until') && sql.includes('FROM instagram_conversations')) return { rows: [{ escalated: true, ai_paused: false }] };
      if (sql.includes("SET status='ai_paused'")) { pausedUpdates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  class FakeAI { async getReply() { aiCalls++; return 'should not run'; } }
  const result = await processIncoming(
    { id: 'mid.9', data: { userId: 'u1', conversationId: 'c1', participantId: 'p1' } },
    {
      database,
      resolveInstagramConfig: async () => ({ enabled: true, config: {} }),
      buildInstagramHistory: async () => [{ role: 'user', content: 'hi' }],
      resolveConfigForAI: async () => ({ openaiApiKey: 'k', model: 'gpt-4o' }),
      AIClient: FakeAI,
      checkMessageQuota: async () => ({ canReply: true }),
      enqueueOutgoingInstagram: async () => {},
    },
  );
  assert.equal(result.skipped, 'ai_paused');
  assert.equal(aiCalls, 0);
  assert.deepStrictEqual(pausedUpdates, [[['m1'], 'u1']]);
});

test('processOutgoing never re-sends when quota bookkeeping fails after Meta accepted the message', async () => {
  const updates = [];
  let sends = 0;
  const database = {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT status')) return { rows: [{ status: 'queued_for_send', provider_message_id: null }] };
      if (sql.includes('window_expires_at > NOW()')) return { rows: [{ window_open: true }] };
      if (sql.includes("SET status='sending'")) return { rows: [{ id: 'r1' }] };
      if (sql.includes("SET status='sent'")) updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const result = await processOutgoing(
    { data: { userId: 'u1', conversationId: 'c1', recipientId: 'p1', text: 'hi', replyMessageId: 'r1' } },
    {
      database,
      checkMessageQuota: async () => ({ canReply: true }),
      getAccountToken: async () => 'token',
      sendDirectMessage: async () => { sends++; return { messageId: 'ig-mid' }; },
      decrementMessageQuota: async () => { throw new Error('db bookkeeping down'); },
      logInstagram: async () => {},
    },
  );
  assert.equal(result.sent, true);
  assert.equal(sends, 1);
  assert.equal(updates.length, 1);
});

test('processOutgoing expires a queued reply outside the 24-hour messaging window', async () => {
  let sends = 0;
  const database = {
    query: async (sql) => {
      if (sql.startsWith('SELECT status')) return { rows: [{ status: 'queued_for_send', provider_message_id: null }] };
      if (sql.includes('window_expires_at > NOW()')) return { rows: [{ window_open: false }] };
      return { rows: [] };
    },
  };
  const result = await processOutgoing(
    { data: { userId: 'u1', conversationId: 'c1', recipientId: 'p1', text: 'hi', replyMessageId: 'r1' } },
    { database, sendDirectMessage: async () => { sends++; }, logInstagram: async () => {} },
  );
  assert.equal(result.skipped, 'window_closed');
  assert.equal(sends, 0);
});

test('shouldGenerateReply true only when AI enabled', () => {
  assert.strictEqual(shouldGenerateReply({ enabled: false }), false);
  assert.strictEqual(shouldGenerateReply({ enabled: true }), true);
  assert.strictEqual(shouldGenerateReply(null), false);
});

test('shouldBlockSendForQuota true only when canReply === false', () => {
  assert.strictEqual(shouldBlockSendForQuota({ canReply: false }), true);
  assert.strictEqual(shouldBlockSendForQuota({ canReply: true }), false);
});

test('buildAiConfig keeps Instagram behavior but injects resolved API keys', () => {
  const igConfig = { botInstructions: 'IG voice', model: 'gpt-4o', storeName: 'IG' };
  const resolved = {
    openaiApiKey: 'sk-real', openrouterApiKey: 'or', googleApiKey: 'g', anthropicApiKey: 'a',
    model: 'gpt-4o-mini', botInstructions: 'WA voice',
  };
  const cfg = buildAiConfig(igConfig, resolved);
  // behavior from Instagram, NOT WhatsApp
  assert.strictEqual(cfg.botInstructions, 'IG voice');
  assert.strictEqual(cfg.storeName, 'IG');
  // keys from the resolved (shared) config
  assert.strictEqual(cfg.openaiApiKey, 'sk-real');
  assert.strictEqual(cfg.anthropicApiKey, 'a');
  // instagram model wins when present
  assert.strictEqual(cfg.model, 'gpt-4o');
});

test('buildAiConfig falls back to resolved model when Instagram has none', () => {
  const cfg = buildAiConfig({ botInstructions: 'x' }, { model: 'gpt-4o', openaiApiKey: 'k' });
  assert.strictEqual(cfg.model, 'gpt-4o');
});
