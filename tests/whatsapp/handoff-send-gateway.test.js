'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('handoff notification uses merchant policy and preserves the approved notification', async () => {
  const h = harness();
  const content = 'تنبيه تحويل لخدمة العملاء\nالمشكلة: يحتاج متابعة';
  const result = await h.gateway.send(request({
    sendClass: 'handoff_notification',
    content,
    policyVersion: h.compiled.policyVersion,
  }));
  assert.equal(result.decision, 'sent');
  assert.equal(h.sends[0].content, content);
});
