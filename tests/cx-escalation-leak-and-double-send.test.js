'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  prepareEscalation,
  stripEscalationMarkers,
  extractEscalationRequest,
} = require('../src/workers/escalation-routing');

// ---------- CX-1: internal [تحويل:...] marker must never leak to the customer ----------

test('CX-1: stripEscalationMarkers removes a malformed marker (no pipe)', () => {
  assert.equal(stripEscalationMarkers('شكراً لك [تحويل:المالك]').trim(), 'شكراً لك');
  assert.equal(stripEscalationMarkers('[تحويل:الدعم|ملخص] أهلاً').trim(), 'أهلاً');
  assert.equal(stripEscalationMarkers('نص بدون علامة'), 'نص بدون علامة');
});

test('CX-1: stripEscalationMarkers removes an unterminated marker', () => {
  assert.equal(stripEscalationMarkers('تمام [تحويل:المالك بدون قوس').trim(), 'تمام');
});

test('CX-1: prepareEscalation never leaks a malformed marker into customerReply', () => {
  // AI emitted a transfer intent but WITHOUT the pipe — MARKER_RE would miss it
  // and the old code passed the raw reply (marker included) to the customer.
  const out = prepareEscalation({
    reply: 'حاضر أحولك للإدارة [تحويل:المالك]',
    config: {},
    customerSender: '966500000000@s.whatsapp.net',
    inboundText: 'ابي اكلم احد',
  });
  assert.doesNotMatch(out.customerReply, /تحويل:/);
  assert.doesNotMatch(out.customerReply, /\[|\]/);
});

test('CX-1: a well-formed marker is still extracted and stripped from the reply', () => {
  const extracted = extractEscalationRequest('تم تحويلك [تحويل:المالك|العميل يطلب مدير]');
  assert.ok(extracted);
  assert.doesNotMatch(extracted.customerReply, /تحويل:/);
  assert.equal(extracted.contactName, 'المالك');
});

// ---------- CX-2: a failed escalation side-channel must not cause a duplicate customer reply ----------
// processAiReply uses the module-level db singleton and can't be unit-run here,
// so (matching this repo's ai-worker test idiom, e.g. escalation-cooldown.test.js)
// we assert the structural guarantees on the source.

const aiWorkerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('CX-2: inbound is marked answered BEFORE the escalation side-channel', () => {
  const answeredIdx = aiWorkerSource.indexOf('await markInboundMessagesAnswered({');
  const escalationIdx = aiWorkerSource.indexOf('if (escalation.ownerMessage) {');
  assert.ok(answeredIdx > 0, 'markInboundMessagesAnswered call must exist');
  assert.ok(escalationIdx > 0, 'escalation block must exist');
  assert.ok(
    answeredIdx < escalationIdx,
    'markInboundMessagesAnswered must run BEFORE the escalation block so a failed escalation cannot trigger a regenerate/duplicate',
  );
});

test('CX-2: the escalation side-channel is wrapped best-effort (does not rethrow)', () => {
  assert.match(
    aiWorkerSource,
    /escalation side-channel failed \(customer already answered\)/,
  );
});

test('CX-2: markInboundMessagesAnswered is invoked at exactly 2 intentional call sites', () => {
  // There are intentionally TWO call sites — both correct and necessary:
  //   1. Duplicate-suppression early-return path (suppressDuplicate branch): marks
  //      the inbound answered so no retry/recovery regenerates a near-duplicate
  //      reply for a message we already sent a response for.
  //   2. B1 success path: marks the inbound answered BEFORE enqueueing the outbound
  //      so a SIGTERM / lock-loss / enqueue-throw cannot leave the inbound in
  //      'queued_for_ai' and trigger a second AI reply via ai-recovery.
  // Any count other than 2 signals either a missing guard or an accidental merge.
  const matches = aiWorkerSource.match(/await markInboundMessagesAnswered\(\{/g) || [];
  assert.equal(matches.length, 2, `expected exactly 2 markInboundMessagesAnswered call sites (dedup-suppression + B1 success path), found ${matches.length}`);
});
