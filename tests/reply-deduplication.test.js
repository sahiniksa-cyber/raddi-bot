'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bigrams,
  findDuplicateRecentReply,
  normalize,
  similarity,
} = require('../src/workers/reply-deduplication');

test('normalize folds Arabic alif/ya/ta-marbuta variants and strips tashkeel', () => {
  assert.equal(normalize('أَهْلاً'), normalize('اهلا'));
  assert.equal(normalize('شركةٌ'), normalize('شركه'));
  assert.equal(normalize('عَلَى'), normalize('علي'));
  assert.equal(normalize('  مرحبًا!  '), 'مرحبا');
});

test('bigrams returns unique character pairs', () => {
  const out = bigrams('abcab');
  assert.deepEqual([...out].sort(), ['ab', 'bc', 'ca'].sort());
});

test('similarity = 1 for identical/equivalent strings, 0 for empty mismatches', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('', 'hello'), 0);
  assert.equal(similarity('أهلاً!', 'اهلا'), 1);
});

test('similarity is high for near-duplicate replies, low for unrelated text', () => {
  const a = 'مرحبا بك، كيف يمكنني مساعدتك اليوم؟';
  const b = 'مرحبا بك. كيف أقدر أساعدك اليوم؟';
  const c = 'الطلب وصل وسيتم شحنه غدا إن شاء الله.';
  assert.ok(similarity(a, b) >= 0.5, `near-dup should be similar (got ${similarity(a, b)})`);
  assert.ok(similarity(a, c) < 0.5, `unrelated should be dissimilar (got ${similarity(a, c)})`);
});

function makeDb(rows) {
  return {
    query: async () => ({ rows }),
  };
}

test('findDuplicateRecentReply returns a match when an earlier reply is near-identical', async () => {
  const db = makeDb([
    { content: 'مرحبا بك، كيف يمكنني مساعدتك اليوم؟' },
    { content: 'تم استلام طلبك بنجاح.' },
  ]);
  const result = await findDuplicateRecentReply({
    db,
    userId: 'u1',
    conversationId: 'c-1',
    candidate: 'مرحباً بك، كيف يمكنني مساعدتك اليوم؟',
    lookback: 3,
    threshold: 0.85,
  });
  assert.ok(result, 'should return a duplicate match');
  assert.ok(result.similarity >= 0.85);
});

test('findDuplicateRecentReply returns null when nothing exceeds threshold', async () => {
  const db = makeDb([
    { content: 'تم استلام طلبك بنجاح.' },
    { content: 'سيتم شحن الطلب اليوم.' },
  ]);
  const result = await findDuplicateRecentReply({
    db,
    userId: 'u1',
    conversationId: 'c-2',
    candidate: 'مرحباً، كيف أقدر أخدمك؟',
    lookback: 3,
    threshold: 0.85,
  });
  assert.equal(result, null);
});

test('findDuplicateRecentReply is safe when DB throws', async () => {
  const db = { query: async () => { throw new Error('boom'); } };
  const result = await findDuplicateRecentReply({
    db,
    userId: 'u1',
    conversationId: 'c-3',
    candidate: 'anything',
  });
  assert.equal(result, null);
});

test('findDuplicateRecentReply returns null for missing required inputs', async () => {
  const db = makeDb([{ content: 'anything' }]);
  assert.equal(await findDuplicateRecentReply({ db, candidate: 'x' }), null);
  assert.equal(await findDuplicateRecentReply({ db, conversationId: 'c' }), null);
  assert.equal(await findDuplicateRecentReply({ conversationId: 'c', candidate: 'x' }), null);
});
