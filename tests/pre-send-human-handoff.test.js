'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reviewFinalReplyBeforeSend,
} = require('../src/services/ai/reply-quality-gate');
const {
  routePreSendEscalation,
} = require('../src/workers/outgoing-whatsapp-worker');

const config = {
  storeName: 'Test Store',
  escalationContacts: [{
    name: 'الموظف',
    role: 'خدمة العملاء',
    phone: '966500000000',
  }],
  replyStyle: { emojiLevel: 'none' },
};

function reviewerResponse(body) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
          usage: {},
        }),
      },
    },
  };
}

test('low-confidence final review requires a human and creates a transfer marker', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'pass',
      reason: 'uncertain',
      confidence: 0.2,
      needs_human: true,
      human_reason: 'missing policy',
      handoff_summary: 'customer needs policy confirmation',
      repeated_claims: [],
      violations: [],
      final_reply: 'أكيد يتم التعويض خلال يومين.',
    }),
    model: 'test',
    draft: 'أكيد يتم التعويض خلال يومين.',
    customerText: 'أبغى تعويض عن المبلغ المخصوم',
    history: [{ role: 'user', speaker: 'customer', content: 'أبغى تعويض عن المبلغ المخصوم' }],
    config,
  });

  assert.equal(result.audit.requiresHuman, true);
  assert.ok(result.audit.confidence < 0.65);
  assert.match(result.reply, /\[تحويل:/);
  assert.doesNotMatch(result.reply, /يومين/);
});

test('final transfer marker is stripped from customer text and enqueued once for the employee', async () => {
  const enqueued = [];
  const routed = await routePreSendEscalation({
    finalReply: 'تم، بخلي الموظف يتابع معك. [تحويل:الموظف|طلب تعويض عن خصم مالي]',
    config,
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    replyMessageId: 'reply-1',
    inboundText: 'أبغى تعويض',
    enqueueOutgoing: async (payload, options) => enqueued.push({ payload, options }),
  });

  assert.equal(routed.escalated, true);
  assert.doesNotMatch(routed.reply, /\[تحويل:/);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.escalation, true);
  assert.equal(enqueued[0].payload.customerSender, 'customer-1@s.whatsapp.net');
  assert.match(enqueued[0].payload.reply, /طلب تعويض/);
});

test('mandatory human handoff overrides a reviewer suppress decision', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'suppress',
      reason: 'duplicate',
      confidence: 0.1,
      needs_human: true,
      human_reason: 'financial problem',
      handoff_summary: 'payment was charged twice',
      repeated_claims: ['already answered'],
      violations: [],
      final_reply: '',
    }),
    model: 'test',
    draft: 'سبق جاوبنا العميل.',
    customerText: 'انخصم المبلغ مرتين وأبغى موظف',
    history: [
      { role: 'assistant', speaker: 'bot', content: 'سبق جاوبنا العميل.' },
      { role: 'user', speaker: 'customer', content: 'انخصم المبلغ مرتين وأبغى موظف' },
    ],
    config,
  });

  assert.equal(result.suppressed, false);
  assert.equal(result.audit.requiresHuman, true);
  assert.match(result.reply, /\[تحويل:/);
});
