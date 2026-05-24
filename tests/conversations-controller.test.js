'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConversationTitle,
  classifyConversation,
  cleanCustomerPhone,
  createConversationsController,
} = require('../src/controllers/conversations.controller');

test('cleanCustomerPhone extracts readable WhatsApp phone numbers', () => {
  assert.equal(cleanCustomerPhone('966501234567@s.whatsapp.net'), '+966501234567');
  assert.equal(cleanCustomerPhone('966501234567@c.us'), '+966501234567');
  assert.equal(cleanCustomerPhone('278571713060916@lid'), '278571713060916@lid');
});

test('buildConversationTitle uses the first customer inquiry', () => {
  assert.equal(buildConversationTitle('[صورة من العميل: كرتون تالف]'), 'صورة من العميل: كرتون تالف');
  assert.equal(buildConversationTitle('كم سعر الاشتراك الشهري؟ وهل فيه ضمان؟'), 'كم سعر الاشتراك الشهري؟ وهل فيه ضمان؟');
});

test('classifyConversation labels recent chats ongoing and older ones finished', () => {
  const now = Date.parse('2026-05-21T20:00:00.000Z');
  assert.equal(classifyConversation('2026-05-21T19:50:00.000Z', { now }), 'ongoing');
  assert.equal(classifyConversation('2026-05-21T19:00:00.000Z', { now }), 'finished');
});

test('conversations controller returns counts, status, and transcripts', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) {
        return { rows: [{ total: 3, ongoing: 1, finished: 2 }] };
      }
      if (/FROM conversations/.test(sql)) {
        return {
          rows: [
            {
              id: 'conv-1',
              sender: '966501234567@s.whatsapp.net',
              last_message_at: new Date().toISOString(),
              first_inquiry: 'ابي السعر',
            },
          ],
        };
      }
      return {
        rows: [
          { conversation_id: 'conv-1', role: 'user', direction: 'inbound', content: 'ابي السعر', created_at: '2026-05-21T20:00:00.000Z' },
          { conversation_id: 'conv-1', role: 'assistant', direction: 'outbound', content: 'السعر 59 ريال', created_at: '2026-05-21T20:00:05.000Z' },
        ],
      };
    },
  };
  const controller = createConversationsController({ database });
  const res = { body: null, json(body) { this.body = body; } };

  await controller.list({ session: { userId: 'user-1' }, query: {} }, res);

  assert.equal(calls.length, 3);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 3);
  assert.deepEqual(res.body.counts, { all: 3, ongoing: 1, finished: 2 });
  assert.equal(res.body.status, 'all');
  assert.equal(res.body.conversations[0].phone, '+966501234567');
  assert.equal(res.body.conversations[0].title, 'ابي السعر');
  assert.equal(res.body.conversations[0].status, 'ongoing');
  assert.deepEqual(res.body.conversations[0].messages.map(m => m.speaker), ['العميل', 'AI']);
});

test('conversations controller filters by status and parameterizes the cutoff', async () => {
  const listCalls = [];
  const database = {
    query: async (sql, params) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 5, ongoing: 2, finished: 3 }] };
      if (/FROM conversations c/.test(sql)) { listCalls.push({ sql, params }); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const controller = createConversationsController({ database });
  const res = { body: null, json(body) { this.body = body; } };

  await controller.list({ session: { userId: 'user-1' }, query: { status: 'finished' } }, res);

  assert.equal(res.body.status, 'finished');
  assert.match(listCalls[0].sql, /c\.last_message_at < \$2/);
});

test('normalizeMessage includes status, hasMedia, mediaKind for outbound messages', () => {
  const { normalizeMessage } = require('../src/controllers/conversations.controller');
  const sent = normalizeMessage({
    role: 'assistant', direction: 'outbound', content: 'hi',
    status: 'sent', raw_payload: null, created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.hasMedia, false);
  assert.equal(sent.mediaKind, null);
});

test('normalizeMessage detects image media from raw_payload', () => {
  const { normalizeMessage } = require('../src/controllers/conversations.controller');
  const msg = normalizeMessage({
    role: 'user', direction: 'inbound', content: '[صورة من العميل: فاتورة]',
    status: 'answered_by_ai',
    raw_payload: { media: { kind: 'image', mimeType: 'image/jpeg' } },
    created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.mediaKind, 'image');
});

test('normalizeMessage detects audio/ptt media kind', () => {
  const { normalizeMessage } = require('../src/controllers/conversations.controller');
  const msg = normalizeMessage({
    role: 'user', direction: 'inbound', content: '[رسالة صوتية]',
    status: 'answered_by_ai',
    raw_payload: { media: { kind: 'ptt' } },
    created_at: '2026-05-24T10:00:00Z',
  });
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.mediaKind, 'ptt');
});

test('cleanCustomerPhone returns +<digits> when row.phone_number is present', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: '966512345678', sender: '276282495500304@lid' }),
    '+966512345678'
  );
});

test('cleanCustomerPhone falls back to sender behavior when phone_number is null', () => {
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '276282495500304@lid' }),
    '276282495500304@lid'
  );
  assert.equal(
    cleanCustomerPhone({ phone_number: null, sender: '966500000000@s.whatsapp.net' }),
    '+966500000000'
  );
});

test('cleanCustomerPhone preserves the string-only signature for backward compat', () => {
  assert.equal(cleanCustomerPhone('966500000000@s.whatsapp.net'), '+966500000000');
  assert.equal(cleanCustomerPhone('276282495500304@lid'), '276282495500304@lid');
});

test('conversations controller list includes phone_number in SELECT and exposes phoneNumber in payload', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1, ongoing: 1, finished: 0 }] };
      if (/FROM conversations c/.test(sql)) {
        return {
          rows: [{
            id: 'conv-1',
            sender: '276282495500304@lid',
            phone_number: '966512345678',
            last_message_at: new Date().toISOString(),
            first_inquiry: 'ابي السعر',
          }],
        };
      }
      return { rows: [] };
    },
  };
  const ctl = createConversationsController({ database });
  let body = null;
  const req = { session: { userId: 'u1' }, query: {} };
  const res = { json: (p) => { body = p; } };
  await ctl.list(req, res);

  const listQuery = calls.find(c => /FROM conversations c/.test(c.sql));
  assert.match(listQuery.sql, /c\.phone_number/);
  assert.equal(body.conversations[0].phoneNumber, '966512345678');
  assert.equal(body.conversations[0].phone, '+966512345678');
});
