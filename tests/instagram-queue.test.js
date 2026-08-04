'use strict';

const test = require('node:test');
const assert = require('node:assert');
const iq = require('../src/queues/instagram-queue');

test('queue names are separate from WhatsApp queues', () => {
  assert.strictEqual(iq.QUEUE_NAMES.incomingInstagram, 'incoming-instagram');
  assert.strictEqual(iq.QUEUE_NAMES.outgoingInstagram, 'outgoing-instagram');
});

test('job options bound retries so a permanent failure never loops forever', () => {
  const opts = iq.buildJobOptions({});
  assert.strictEqual(opts.attempts, 3);                 // finite retry ceiling
  assert.strictEqual(opts.backoff.type, 'exponential'); // spaced, not hammering
  assert.ok(opts.backoff.delay >= 1000);
  assert.ok(opts.removeOnFail);                          // failed jobs are reaped, not kept forever
});

test('buildJobOptions honors an env-configured attempts ceiling', () => {
  assert.strictEqual(iq.buildJobOptions({ QUEUE_JOB_ATTEMPTS: '5' }).attempts, 5);
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

test('a completed incoming job id is removed before the same Meta delivery is re-enqueued', async () => {
  let removed = 0;
  let added = 0;
  iq.__setQueuesForTest({
    incomingInstagram: {
      getJob: async () => ({ getState: async () => 'completed', remove: async () => { removed++; } }),
      add: async () => { added++; },
    },
    outgoingInstagram: { add: async () => {} },
  });
  await iq.enqueueIncomingInstagram({ providerMessageId: 'mid.retry', userId: 'u1' });
  assert.strictEqual(removed, 1);
  assert.strictEqual(added, 1);
});
