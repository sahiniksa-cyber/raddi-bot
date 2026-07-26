'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('campaign text and media remain byte-equivalent after authorization', async () => {
  const h = harness();
  const media = { document: Buffer.from('pdf'), fileName: 'عرض.pdf' };
  const content = 'عرض اليوم\nhttps://merchant.invalid/offer';
  const result = await h.gateway.send(request({
    sendClass: 'campaign',
    content,
    media,
    policyVersion: h.compiled.policyVersion,
  }));
  assert.equal(result.decision, 'sent');
  assert.equal(h.sends[0].content, content);
  assert.equal(h.sends[0].media, media);
});
