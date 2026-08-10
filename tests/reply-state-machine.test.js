'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertReplyReadyForSend,
  transitionReplyState,
} = require('../src/services/ai/reply-state-machine');

test('reply lifecycle accepts the complete safe path', () => {
  let state = 'received';
  for (const next of ['processing', 'generated', 'validated', 'queued_for_send', 'sent']) {
    state = transitionReplyState(state, next);
  }
  assert.equal(state, 'sent');
});

test('send is forbidden before deterministic validation completes', () => {
  for (const state of ['received', 'processing', 'generated', 'blocked', 'failed']) {
    assert.throws(
      () => assertReplyReadyForSend({ state, validationDecision: 'validated' }),
      /not ready for send/,
    );
  }
  assert.throws(
    () => assertReplyReadyForSend({ state: 'queued_for_send', validationDecision: 'blocked' }),
    /deterministic validation/,
  );
  assert.doesNotThrow(
    () => assertReplyReadyForSend({ state: 'queued_for_send', validationDecision: 'validated' }),
  );
});

test('illegal regressions and transitions from sent are rejected', () => {
  assert.throws(() => transitionReplyState('generated', 'processing'), /illegal reply state transition/);
  assert.throws(() => transitionReplyState('sent', 'queued_for_send'), /terminal/);
});

test('failure and human escalation transitions are explicit', () => {
  assert.equal(transitionReplyState('processing', 'failed'), 'failed');
  assert.equal(transitionReplyState('failed', 'processing'), 'processing');
  assert.equal(transitionReplyState('blocked', 'escalated'), 'escalated');
});
