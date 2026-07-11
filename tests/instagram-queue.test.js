'use strict';

const test = require('node:test');
const assert = require('node:assert');
const iq = require('../src/queues/instagram-queue');

test('queue names are separate from WhatsApp queues', () => {
  assert.strictEqual(iq.QUEUE_NAMES.incomingInstagram, 'incoming-instagram');
  assert.strictEqual(iq.QUEUE_NAMES.outgoingInstagram, 'outgoing-instagram');
});

test('enqueueIncomingInstagram adds job with dedup jobId + correct name', async () => {
  const added = [];
  iq.__setQueuesForTest({
    incomingInstagram: { add: async (name, payload, opts) => { added.push({ name, payload, opts }); } },
    outgoingInstagram: { add: async () => {} },
  });
  await iq.enqueueIncomingInstagram({ providerMessageId: 'mid.1', userId: 'u1' });
  assert.strictEqual(added[0].opts.jobId, 'mid.1');
  assert.strictEqual(added[0].name, 'process-incoming-instagram');
});

test('enqueueOutgoingInstagram uses replyMessageId as jobId', async () => {
  const added = [];
  iq.__setQueuesForTest({
    incomingInstagram: { add: async () => {} },
    outgoingInstagram: { add: async (name, payload, opts) => { added.push({ name, opts }); } },
  });
  await iq.enqueueOutgoingInstagram({ replyMessageId: 'r1', userId: 'u1', recipientId: 'IGSID', text: 'hi' });
  assert.strictEqual(added[0].opts.jobId, 'r1');
  assert.strictEqual(added[0].name, 'send-instagram-message');
});

test('explicit jobKey overrides derived id', async () => {
  const added = [];
  iq.__setQueuesForTest({
    incomingInstagram: { add: async (name, payload, opts) => { added.push(opts); } },
    outgoingInstagram: { add: async () => {} },
  });
  await iq.enqueueIncomingInstagram({ providerMessageId: 'mid.1' }, { jobKey: 'ig-conversation-7', delay: 5000 });
  assert.strictEqual(added[0].jobId, 'ig-conversation-7');
  assert.strictEqual(added[0].delay, 5000);
});
