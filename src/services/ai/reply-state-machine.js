'use strict';

const TERMINAL = new Set(['sent', 'escalated']);
const TRANSITIONS = Object.freeze({
  received: new Set(['processing', 'failed']),
  processing: new Set(['generated', 'blocked', 'failed', 'escalated']),
  generated: new Set(['validated', 'blocked', 'failed']),
  validated: new Set(['queued_for_send', 'blocked', 'escalated']),
  blocked: new Set(['escalated']),
  queued_for_send: new Set(['sent', 'failed', 'blocked', 'escalated']),
  failed: new Set(['processing', 'escalated']),
  escalated: new Set(),
  sent: new Set(),
});

function normalizeState(value) {
  return String(value || '').trim().toLowerCase();
}

function transitionReplyState(current, next) {
  const from = normalizeState(current);
  const to = normalizeState(next);
  if (!TRANSITIONS[from]) throw new Error(`unknown reply state: ${from || 'empty'}`);
  if (!TRANSITIONS[to]) throw new Error(`unknown reply state: ${to || 'empty'}`);
  if (TERMINAL.has(from)) {
    throw new Error(`reply state ${from} is terminal`);
  }
  if (!TRANSITIONS[from].has(to)) {
    throw new Error(`illegal reply state transition: ${from} -> ${to}`);
  }
  return to;
}

function assertReplyReadyForSend({ state, validationDecision } = {}) {
  if (normalizeState(state) !== 'queued_for_send') {
    throw new Error(`reply is not ready for send from state ${normalizeState(state) || 'empty'}`);
  }
  if (normalizeState(validationDecision) !== 'validated') {
    throw new Error('reply cannot send without completed deterministic validation');
  }
  return true;
}

module.exports = {
  REPLY_STATES: Object.freeze(Object.keys(TRANSITIONS)),
  assertReplyReadyForSend,
  transitionReplyState,
};
