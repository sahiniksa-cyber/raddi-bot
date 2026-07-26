'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { shouldBlockOutgoingForQuota } = require('../src/workers/outgoing-whatsapp-worker');

// The hard rule the merchant asked for: when remaining hits 0, NO customer
// reply goes out — from ANY path. Team-facing escalation alerts/forwards stay
// exempt so the merchant still learns a customer needs help.

test('customer-facing reply is blocked when quota is empty', () => {
  assert.equal(shouldBlockOutgoingForQuota({ escalation: false }, { canReply: false, reason: 'empty' }), true);
});

test('customer-facing reply goes out when quota is available', () => {
  assert.equal(shouldBlockOutgoingForQuota({ escalation: false }, { canReply: true, remaining: 5 }), false);
});

test('escalation-bridge relay (team solution to customer) IS blocked at zero — it is customer-facing', () => {
  // source 'escalation_bridge' carries no escalation flag → customer-facing.
  assert.equal(shouldBlockOutgoingForQuota({ source: 'escalation_bridge' }, { canReply: false, reason: 'empty' }), true);
});

test('team-facing escalation (notification + customer-forward) is NEVER blocked', () => {
  assert.equal(shouldBlockOutgoingForQuota({ escalation: true }, { canReply: false, reason: 'empty' }), false);
  assert.equal(shouldBlockOutgoingForQuota({ escalation: true, source: 'escalation_bridge_forward' }, { canReply: false, reason: 'expired' }), false);
});

test('blocks on every no-quota reason (empty / expired / no_account)', () => {
  for (const reason of ['empty', 'expired', 'no_account']) {
    assert.equal(shouldBlockOutgoingForQuota({}, { canReply: false, reason }), true, reason);
  }
});

// Wiring: the outgoing worker must consult the quota BEFORE the send, at the
// universal chokepoint, so overshoot (two jobs racing on remaining=1) and the
// bridge-relay path are both caught.

test('processOutgoingWhatsapp checks quota before sending (chokepoint gate)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'outgoing-whatsapp-worker.js'), 'utf8');
  assert.match(src, /checkMessageQuota/, 'outgoing worker must import + use checkMessageQuota');
  const gateIdx = src.indexOf('shouldBlockOutgoingForQuota');
  const sendIdx = src.indexOf('await gateway.send');
  assert.ok(gateIdx > -1 && gateIdx < sendIdx, 'quota gate must run before the send');
  // @lid path is also gated
  const lidStart = src.indexOf('async function handleLidOutgoing');
  const lidEnd = src.indexOf('async function notifyOwnerOfLidFailure');
  assert.match(src.slice(lidStart, lidEnd), /shouldBlockOutgoingForQuota/, '@lid path must also be gated');
});
