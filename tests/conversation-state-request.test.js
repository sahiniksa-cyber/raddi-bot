'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExtractionRequest } = require('../src/services/ai/conversation-state');

test('buildExtractionRequest yields a system+user message pair with prior state and new turns', () => {
  const req = buildExtractionRequest({
    previousState: { open_issues: [{ id: 'iss_1', summary: 'order not arrived', status: 'open' }] },
    newTurns: [{ role: 'user', content: 'خلاص وصل الطلب' }],
    lastBotReply: 'رح أتابع لك الشحنة',
  });
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].role, 'user');
  assert.ok(req.max_tokens > 0 && req.max_tokens <= 700);
  assert.ok(req.temperature <= 0.3);
  // Generic: the system prompt must NOT hardcode any brand/vertical term.
  const sys = req.messages[0].content;
  for (const banned of ['adobe', 'canva', 'stc', 'prostore', 'برو']) {
    assert.ok(!sys.toLowerCase().includes(banned), `system prompt leaks "${banned}"`);
  }
  // Must instruct customer-confirmed resolution + not stamping systemic state.
  assert.ok(/resolved_issues/.test(sys));
  assert.ok(/handoff|تحويل|النظام/.test(sys));
  // Prior state + new turn are present in the user content.
  assert.ok(req.messages[1].content.includes('order not arrived'));
  assert.ok(req.messages[1].content.includes('خلاص وصل الطلب'));
});
