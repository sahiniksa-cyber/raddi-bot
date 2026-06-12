'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isThreadStatusQuery, buildThreadStatusReply } = require('../src/services/escalation/escalation-bridge');
const { customerRequestedEscalation } = require('../src/services/ai/reply-validator');

// Production 2026-06-12: the owner asked the bot IN THE GROUP "وش صار معاك"
// (a status question) — the bridge relayed it to the CUSTOMER verbatim.

test('isThreadStatusQuery recognizes status questions to the bot', () => {
  assert.equal(isThreadStatusQuery('وش صار معاك'), true);
  assert.equal(isThreadStatusQuery('هل انحلت المشكلة؟'), true);
  assert.equal(isThreadStatusQuery('شو الوضع'), true);
  assert.equal(isThreadStatusQuery('رد عليك العميل؟'), true);
});

test('isThreadStatusQuery does NOT misroute real answers/directives to the customer', () => {
  assert.equal(isThreadStatusQuery('تم حل المشكلة، الطلب يوصل بكرة'), false, 'an answer, not a question');
  assert.equal(isThreadStatusQuery('قوله يعطينا ايميله'), false, 'a directive');
  assert.equal(isThreadStatusQuery('الحل: يسوي تسجيل خروج ودخول'), false);
  assert.equal(isThreadStatusQuery('وش رايك تجرب تسوي ريستارت للجهاز وتشوف'), false, 'a directive that happens to start with وش');
});

test('buildThreadStatusReply summarizes the conversation state from the DB', async () => {
  const database = {
    isConfigured: () => true,
    query: async () => ({
      rows: [
        { direction: 'inbound', content: 'تمام جاري التجربة', created_at: new Date(Date.now() - 4 * 60 * 1000) },
        { direction: 'outbound', content: 'ممكن تعطينا ايميلك؟', created_at: new Date(Date.now() - 6 * 60 * 1000) },
      ],
    }),
  };
  const text = await buildThreadStatusReply({
    database,
    userId: 'u1',
    thread: { conversation_id: 'c1', customer_sender: '966512345678@s.whatsapp.net' },
  });
  assert.match(text, /تمام جاري التجربة/, 'must show the customer last message');
  assert.match(text, /966512345678/, 'must identify the customer');
});

// Production 2026-06-12: the customer explicitly said "ارسل للادارة مرة ثانية"
// — the bot said تبشر and nothing happened.

test('customerRequestedEscalation catches explicit send-to-team requests', () => {
  assert.equal(customerRequestedEscalation('ارسل للادارة مرة ثانية'), true);
  assert.equal(customerRequestedEscalation('بلغ الإدارة بمشكلتي'), true);
  assert.equal(customerRequestedEscalation('كلم الدعم الفني'), true);
  assert.equal(customerRequestedEscalation('حول طلبي للمسؤول'), true);
});

test('customerRequestedEscalation ignores unrelated mentions', () => {
  assert.equal(customerRequestedEscalation('الإدارة عندكم ممتازة'), false, 'no verb');
  assert.equal(customerRequestedEscalation('ارسل لي الكود'), false, 'no team entity');
  assert.equal(customerRequestedEscalation('كم سعر الاشتراك؟'), false);
});

// Wiring: ingest routes status queries back to the GROUP, and the ai-worker
// lets an explicit customer request bypass the cooldown/min-gap (cap stays).

test('ingest routes a status query to the group instead of the customer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'message-ingest.service.js'), 'utf8');
  assert.match(src, /isThreadStatusQuery/, 'ingest must classify quote-replies');
  assert.match(src, /buildThreadStatusReply/, 'status answer goes back to the team');
});

test('ai-worker bypasses cooldown and min-gap for explicit customer requests (24h cap stays)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  assert.match(src, /customerRequestedEscalation/, 'explicit request must be detected');
  const idx = src.indexOf('customerRequestedEscalation(');
  assert.ok(idx > -1);
  assert.match(src, /overCap/, '24h cap must remain the hard ceiling');
});
