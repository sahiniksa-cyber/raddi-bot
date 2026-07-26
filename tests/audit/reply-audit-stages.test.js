'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, request } = require('../helpers/send-gateway-harness');

test('audit reconstructs original draft, every named modification, decision, and send result', async () => {
  const h = harness();
  const result = await h.gateway.send(request({
    originalContent: 'draft-v0',
    draftStages: [
      { layer: 'llm_advisory_review', content: 'draft-v1', metadata: { advisory: true } },
      { layer: 'deterministic_post_process', content: 'final-v2', metadata: { removed: ['x'] } },
    ],
    content: 'final-v2',
  }));
  assert.equal(result.decision, 'sent');
  assert.deepEqual(
    h.events.map(event => [event.stage, event.content, event.metadata.layer || null]),
    [
      ['original', 'draft-v0', null],
      ['modified', 'draft-v1', 'llm_advisory_review'],
      ['modified', 'final-v2', 'deterministic_post_process'],
      ['authorized', 'final-v2', null],
      ['sent', 'final-v2', null],
    ],
  );
});

test('gateway snapshots stage history before asynchronous dependencies run', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const h = harness({
    scopeStore: { assertSendScope: async () => wait },
  });
  const envelope = request({
    originalContent: 'draft',
    draftStages: [{ layer: 'review', content: 'reviewed' }],
    content: 'reviewed',
  });
  const pending = h.gateway.send(envelope);
  envelope.draftStages[0].content = 'tampered';
  envelope.draftStages.push({ layer: 'attacker', content: 'tampered' });
  release();
  await pending;
  assert.equal(h.events.some(event => event.content === 'tampered'), false);
  assert.equal(h.events.filter(event => event.stage === 'modified').length, 1);
});
