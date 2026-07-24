'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reviewOutgoingReplyBeforeSend } = require('../src/services/ai/pre-send-review');

function makeDatabase({ persisted = null } = {}) {
  const updates = [];
  return {
    updates,
    isConfigured: () => true,
    query: async (sql, params) => {
      if (/SELECT id, content, raw_payload/.test(sql)) {
        return {
          rows: [{
            id: 'reply-2',
            content: persisted?.content || 'والله يا غالي، حالياً ما عندنا كود خصم شغال، لكن تقدر تستفيد من تقسيط تمارا.',
            raw_payload: persisted?.rawPayload || {},
          }],
        };
      }
      if (/SELECT role, direction, content/.test(sql)) {
        return { rows: [
          { role: 'assistant', direction: 'outbound', content: 'حالياً ما عندنا كود خصم، ونقدر نوفر لك تقسيط مع تمارا.', status: 'sent' },
          { role: 'user', direction: 'inbound', content: 'باخذ ادوبي وباخذ فريبيك', status: 'answered_by_ai' },
        ] };
      }
      if (/UPDATE messages/.test(sql)) {
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const base = {
  payload: {
    source: 'ai_reply',
    preSendReviewRequired: true,
    sender: 'customer-1@s.whatsapp.net',
    customerId: 'customer-1@s.whatsapp.net',
  },
  userId: 'user-1',
  conversationId: 'conversation-1',
  replyMessageId: 'reply-2',
  draft: 'stale queue copy',
};

test('reviews the persisted final draft with the already-sent assistant reply', async () => {
  const database = makeDatabase();
  let received;
  const bot = {
    reviewReplyBeforeSend: async (input) => {
      received = input;
      return {
        reply: 'إذا حاب تدفع بالتقسيط، أعطني رقم جوالك وأرسل لك طلب الدفع.',
        suppressed: false,
        audit: { decision: 'repair', repeatedClaims: ['لا يوجد كود خصم', 'تقسيط تمارا'] },
      };
    },
  };

  const result = await reviewOutgoingReplyBeforeSend({ database, bot, ...base });
  assert.equal(received.draft.includes('حالياً ما عندنا كود خصم'), true, 'database text wins over a stale queue payload');
  assert.equal(received.history.some(message => message.role === 'assistant' && /تقسيط مع تمارا/.test(message.content)), true);
  assert.equal(received.customerText, 'باخذ ادوبي وباخذ فريبيك');
  assert.equal(result.reply, 'إذا حاب تدفع بالتقسيط، أعطني رقم جوالك وأرسل لك طلب الدفع.');
  assert.equal(database.updates.length, 1);
  assert.equal(database.updates[0].params[2], result.reply);
  assert.match(database.updates[0].params[4], /preSendReview/);
});

test('persists suppress and returns no sendable text when the reply adds nothing', async () => {
  const database = makeDatabase();
  const bot = {
    reviewReplyBeforeSend: async () => ({
      reply: '',
      suppressed: true,
      audit: { decision: 'suppress', reason: 'semantic duplicate' },
    }),
  };
  const result = await reviewOutgoingReplyBeforeSend({ database, bot, ...base });
  assert.equal(result.suppressed, true);
  assert.equal(result.reply, '');
  assert.equal(database.updates[0].params[2], '');
  assert.equal(database.updates[0].params[3], true);
});

test('reuses a persisted review on retry and never calls the AI twice', async () => {
  const database = makeDatabase({
    persisted: {
      content: 'النص المراجع',
      rawPayload: { preSendReview: { status: 'reviewed', decision: 'repair' } },
    },
  });
  let calls = 0;
  const bot = { reviewReplyBeforeSend: async () => { calls++; throw new Error('must not run'); } };
  const result = await reviewOutgoingReplyBeforeSend({ database, bot, ...base });
  assert.equal(result.reused, true);
  assert.equal(result.reply, 'النص المراجع');
  assert.equal(calls, 0);
  assert.equal(database.updates.length, 0);
});

test('fails closed when the reviewer is unavailable', async () => {
  const database = makeDatabase();
  await assert.rejects(
    reviewOutgoingReplyBeforeSend({ database, bot: {}, ...base }),
    /reviewer is unavailable/,
  );
  assert.equal(database.updates.length, 0);
});

test('AI failure fallback is still reviewed even though it has no stored reply row', async () => {
  const database = makeDatabase();
  let calls = 0;
  const bot = {
    reviewReplyBeforeSend: async ({ draft, source }) => {
      calls++;
      assert.equal(draft, 'لحظات من فضلك، نراجع طلبك ونرجعلك بأقرب وقت');
      assert.equal(source, 'ai_failure_fallback');
      return { reply: draft, suppressed: false, audit: { decision: 'pass' } };
    },
  };
  const result = await reviewOutgoingReplyBeforeSend({
    database,
    bot,
    ...base,
    payload: {
      source: 'ai_failure_fallback',
      preSendReviewRequired: true,
      sender: 'customer-1@s.whatsapp.net',
      customerId: 'customer-1@s.whatsapp.net',
    },
    replyMessageId: null,
    draft: 'لحظات من فضلك، نراجع طلبك ونرجعلك بأقرب وقت',
  });
  assert.equal(result.reply, 'لحظات من فضلك، نراجع طلبك ونرجعلك بأقرب وقت');
  assert.equal(calls, 1);
  assert.equal(database.updates.length, 0, 'there is no outbound row to persist for this legacy fallback path');
});

test('final review sees only the current session and distinguishes the owner from the bot', async () => {
  let received;
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      if (/SELECT id, content, raw_payload/.test(sql)) {
        return {
          rows: [{
            id: 'reply-incident',
            content: 'لا تشيل هم، تقدر تشترك بكرة براحتك بالنسبة للخصم، الاشتراك عليه تخفيض حالياً.',
            raw_payload: {},
          }],
        };
      }
      if (/SELECT role, direction, content/.test(sql)) {
        return {
          rows: [
            {
              role: 'user',
              direction: 'inbound',
              status: 'answered_by_ai',
              content: 'الين بكرة اقدر حاليا اليوم م اقدر اشترك',
              raw_payload: {},
              created_at: '2026-07-18T09:01:00.000Z',
            },
            {
              role: 'assistant',
              direction: 'outbound',
              status: 'sent',
              content: 'السلام عليكم اكدي لنا اذا حابه التفعيل اليوم عشان قبل ما نقفل النظام',
              raw_payload: { source: 'manual_send' },
              created_at: '2026-07-18T09:00:00.000Z',
            },
            {
              role: 'assistant',
              direction: 'outbound',
              status: 'sent_by_human',
              content: 'لا والله عشان الان عليه فعلاً خصم',
              raw_payload: { fromMe: true },
              created_at: '2026-07-17T14:01:00.000Z',
            },
            {
              role: 'user',
              direction: 'inbound',
              status: 'answered_by_human',
              content: 'لو بشترك ادوبي ٨ اشهر هل في خصم؟',
              raw_payload: {},
              created_at: '2026-07-17T14:00:00.000Z',
            },
          ],
        };
      }
      if (/UPDATE messages/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const bot = {
    reviewReplyBeforeSend: async (input) => {
      received = input;
      return {
        reply: 'أبد وقت ما تحبي، بين يدينك.',
        suppressed: false,
        audit: { decision: 'repair' },
      };
    },
  };

  await reviewOutgoingReplyBeforeSend({
    database,
    bot,
    payload: {
      source: 'ai_reply',
      preSendReviewRequired: true,
      sender: 'customer-1@s.whatsapp.net',
      customerId: 'customer-1@s.whatsapp.net',
    },
    userId: 'user-1',
    conversationId: 'conversation-1',
    replyMessageId: 'reply-incident',
    draft: 'stale',
  });

  assert.deepEqual(received.history.map(message => ({
    role: message.role,
    speaker: message.speaker,
    content: message.content,
  })), [
    {
      role: 'assistant',
      speaker: 'owner',
      content: 'السلام عليكم اكدي لنا اذا حابه التفعيل اليوم عشان قبل ما نقفل النظام',
    },
    {
      role: 'user',
      speaker: 'customer',
      content: 'الين بكرة اقدر حاليا اليوم م اقدر اشترك',
    },
  ]);
  assert.equal(received.history.some(message => /خصم/.test(message.content)), false);
});
