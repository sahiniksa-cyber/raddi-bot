'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('human manual reply preserves employee bytes through the unified gateway', async () => {
  const h = harness();
  const content = 'نص الموظف  كما كتبه\nبدون تغيير';
  const result = await h.gateway.send(request({
    sendClass: 'human_manual_reply',
    content,
    policyVersion: h.compiled.policyVersion,
  }));
  assert.equal(result.decision, 'sent');
  assert.equal(h.sends[0].content, content);
});
