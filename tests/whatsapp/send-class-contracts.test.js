'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORM_REPLY_POLICY } = require('../../src/policy/platform-reply-policy');
const { harness, request } = require('../helpers/send-gateway-harness');

test('human and campaign wording is preserved byte-for-byte', async () => {
  for (const sendClass of ['human_manual_reply', 'campaign', 'handoff_notification']) {
    const h = harness();
    const content = 'نص الموظف  كما هو\nhttps://example.invalid/X';
    const result = await h.gateway.send(request({
      sendClass,
      content,
      policyVersion: h.compiled.policyVersion,
    }));
    assert.equal(result.decision, 'sent');
    assert.equal(h.sends[0].content, content);
  }
});

test('platform alerts require the code-owned platform policy version', async () => {
  const h = harness();
  const result = await h.gateway.send(request({
    sendClass: 'platform_alert',
    policyVersion: PLATFORM_REPLY_POLICY.policyVersion,
  }));
  assert.equal(result.decision, 'sent');
});
