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

// ---------- CX-2: real escalation ordering + no false promise ----------
// processAiReply uses the module-level db singleton and can't be unit-run here,
// so (matching this repo's ai-worker test idiom) we assert the structural
// ordering on the source; behavior is proven in support-contract-ai-worker.test.js.
// Blocker-1 architecture: the REAL team escalation is forwarded BEFORE the customer
// acknowledgement is enqueued, and the ack's handoff claim is gated on the ACTUAL
// delivery result (escalationDelivered), never on merely resolving a target.

const aiWorkerSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'),
  'utf8',
);

test('CX-2 (Blocker 1): team escalation is forwarded BEFORE the customer reply is enqueued', () => {
  const forwardIdx = aiWorkerSource.indexOf('await forwardTeamEscalation({');
  const custEnqueueIdx = aiWorkerSource.indexOf('handoffAcknowledgement: escalationDelivered');
  assert.ok(forwardIdx > 0, 'forwardTeamEscalation call must exist');
  assert.ok(custEnqueueIdx > 0, 'customer enqueue must gate handoff on escalationDelivered');
  assert.ok(forwardIdx < custEnqueueIdx, 'escalation must be forwarded before the customer acknowledgement');
});

test('CX-2 (Blocker 1): the customer ack claims a handoff ONLY from the real delivery result', () => {
  // handoffAcknowledgement and the contract escalationEnqueued must both be the
  // REAL escalationDelivered boolean — never Boolean(escalation.ownerMessage).
  assert.match(aiWorkerSource, /escalationEnqueued: escalationDelivered/);
  assert.match(aiWorkerSource, /handoffAcknowledgement: escalationDelivered/);
  assert.doesNotMatch(aiWorkerSource, /handoffAcknowledgement: Boolean\(escalation\.ownerMessage\)/);
});

test('CX-2 (Blocker 6): the contract is fail-closed to a neutral ack, not the dangerous draft', () => {
  assert.match(aiWorkerSource, /fail-closed to neutral ack/);
  assert.match(aiWorkerSource, /customerReply = buildNeutralAck\(\)/);
});

test('Blocker 2: the contract is the LAST gate — it runs AFTER every regeneration path', () => {
  // reopen-guard regeneration and semantic/dedup regeneration both mutate
  // customerReply; the contract reconcile (positioned right after the escalation
  // forward) MUST come after both so a regenerated draft cannot bypass it.
  const reopenIdx = aiWorkerSource.indexOf('detectResolvedReopen(customerReply');
  const dedupIdx = aiWorkerSource.indexOf('findDuplicateRecentReply({');
  const forwardIdx = aiWorkerSource.indexOf('await forwardTeamEscalation({');
  const contractIdx = aiWorkerSource.indexOf('const contract = reconcileSupportReply({');
  assert.ok(reopenIdx > 0 && dedupIdx > 0 && forwardIdx > 0 && contractIdx > 0, 'all anchors present');
  assert.ok(reopenIdx < forwardIdx, 'reopen-guard regeneration runs before the contract');
  assert.ok(dedupIdx < forwardIdx, 'dedup regeneration runs before the contract');
  assert.ok(forwardIdx < contractIdx, 'escalation is forwarded before the contract reconciles the ack');
});

test('CX-2: markInboundMessagesAnswered is invoked at exactly 2 intentional call sites', () => {
  // 1. Duplicate-suppression early-return; 2. B1 success path (before enqueue).
  const matches = aiWorkerSource.match(/await markInboundMessagesAnswered\(\{/g) || [];
  assert.equal(matches.length, 2, `expected exactly 2 markInboundMessagesAnswered call sites, found ${matches.length}`);
});
