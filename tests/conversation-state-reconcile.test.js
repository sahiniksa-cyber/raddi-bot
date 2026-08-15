'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileSystemState } = require('../src/services/ai/conversation-state');

test('LLM cannot stamp owner-resolution; system decides handoff', () => {
  const llm = {
    open_issues: [{ id: 'iss_1', summary: 'refund', status: 'open' }],
    resolved_issues: [{ id: 'iss_2', summary: 'the team handled it', resolved_by: 'owner' }],
    actions_attempted: [{ action: 'refund', outcome: 'worked', confirmed_by: 'system' }],
  };
  const out = reconcileSystemState(llm, { escalationPending: true });
  // LLM-claimed owner resolution is stripped (system owns it).
  assert.equal(out.resolved_issues.find((i) => i.id === 'iss_2'), undefined);
  // LLM-claimed system-confirmed action is downgraded (no real tool record).
  assert.equal(out.actions_attempted[0].confirmed_by, null);
  // System handoff fact is surfaced authoritatively.
  assert.equal(out.system.escalationPending, true);
});

test('reconcile keeps customer-confirmed resolutions untouched', () => {
  const llm = {
    resolved_issues: [{ id: 'iss_9', summary: 'login', resolved_by: 'customer_confirmed' }],
    actions_attempted: [{ action: 'x', outcome: 'worked', confirmed_by: 'customer' }],
  };
  const out = reconcileSystemState(llm, { escalationPending: false });
  assert.equal(out.resolved_issues[0].resolved_by, 'customer_confirmed');
  assert.equal(out.actions_attempted[0].confirmed_by, 'customer');
  assert.equal(out.system.escalationPending, false);
});
