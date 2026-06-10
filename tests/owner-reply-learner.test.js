'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLearnablePair,
  normalizeQuestion,
  extractLearnablePairs,
  saveLearnedReplies,
  loadActiveLearnedReplies,
  runLearningPass,
} = require('../src/services/learning/owner-reply-learner');

function fakeDbCapture(rowsByCall = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const rows = rowsByCall[Math.min(i, rowsByCall.length - 1)] || [];
      i++;
      return { rows };
    },
  };
}

// ── isLearnablePair: the quality gate that keeps junk out of the knowledge base

test('isLearnablePair accepts a real question with a real owner answer', () => {
  assert.equal(isLearnablePair('كم يستغرق الشحن للرياض؟', 'الشحن للرياض يومين عمل وبرسوم 25 ريال'), true);
});

test('isLearnablePair rejects short/greeting/media/escalation content', () => {
  assert.equal(isLearnablePair('هلا', 'الشحن يومين عمل للرياض'), false, 'short question');
  assert.equal(isLearnablePair('كم يستغرق الشحن للرياض؟', 'تم'), false, 'short answer');
  assert.equal(isLearnablePair('[صورة من العميل]', 'الشحن يومين عمل للرياض'), false, 'media placeholder question');
  assert.equal(isLearnablePair('كم يستغرق الشحن للرياض؟', 'وعليكم السلام ورحمة الله'), false, 'greeting-only answer');
  assert.equal(isLearnablePair('كم يستغرق الشحن؟', 'ثواني أحولك [تحويل:أحمد|مشكلة شحن]'), false, 'escalation marker in answer');
});

// ── normalizeQuestion: dedup key

test('normalizeQuestion normalizes Arabic variants to one key', () => {
  assert.equal(normalizeQuestion('كم يستغرق الشحن؟'), normalizeQuestion('كم يستغرق الشحن'));
  assert.equal(normalizeQuestion('متى تفتحون؟ '), normalizeQuestion('متي تفتحون'));
});

// ── saveLearnedReplies

test('saveLearnedReplies inserts with ON CONFLICT dedup and respects the total cap', async () => {
  const database = fakeDbCapture([[{ n: '0' }], []]);
  const pairs = [{ question: 'كم يستغرق الشحن للرياض؟', answer: 'يومين عمل وبرسوم 25 ريال', conversationId: 'c1', messageId: 'm1' }];
  const result = await saveLearnedReplies({ database, userId: 'u1', pairs });
  assert.equal(result.saved, 1);
  assert.match(database.calls[0].sql, /SELECT COUNT/i);
  assert.match(database.calls[1].sql, /ON CONFLICT \(user_id, normalized_question\) DO NOTHING/);
});

test('saveLearnedReplies stops when the active total cap is reached', async () => {
  const database = fakeDbCapture([[{ n: '300' }]]);
  const result = await saveLearnedReplies({
    database,
    userId: 'u1',
    pairs: [{ question: 'سؤال طويل بما يكفي هنا؟', answer: 'جواب طويل بما يكفي هنا', conversationId: 'c', messageId: 'm' }],
  });
  assert.equal(result.saved, 0);
  assert.equal(result.reason, 'cap_reached');
  assert.equal(database.calls.length, 1, 'must not attempt inserts past the cap');
});

test('saveLearnedReplies caps a single run at 20 pairs', async () => {
  const database = fakeDbCapture([[{ n: '0' }], []]);
  const pairs = Array.from({ length: 35 }, (_, i) => ({
    question: `سؤال رقم ${i} طويل بما يكفي؟`,
    answer: `جواب رقم ${i} طويل بما يكفي`,
    conversationId: 'c', messageId: 'm',
  }));
  const result = await saveLearnedReplies({ database, userId: 'u1', pairs });
  assert.ok(result.saved <= 20, `saved ${result.saved}, expected <= 20`);
});

// ── extractLearnablePairs

test('extractLearnablePairs pairs owner replies with the latest unanswered inbound', async () => {
  const database = fakeDbCapture([[{
    owner_message_id: 'om1', conversation_id: 'c1',
    answer: 'الشحن يومين عمل وبرسوم 25 ريال',
    question_message_id: 'im1', question: 'كم يستغرق الشحن للرياض؟',
  }]]);
  const pairs = await extractLearnablePairs({ database, userId: 'u1' });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].question, 'كم يستغرق الشحن للرياض؟');
  assert.equal(pairs[0].answer, 'الشحن يومين عمل وبرسوم 25 ريال');
  const sql = database.calls[0].sql;
  assert.match(sql, /sent_by_human/);
  assert.match(sql, /<> 'answered_by_ai'/);
  assert.match(sql, /LATERAL/i);
});

// ── loadActiveLearnedReplies

test('loadActiveLearnedReplies shapes entries for knowledge injection', async () => {
  const database = fakeDbCapture([[{ question: 'كم يستغرق الشحن؟', answer: 'يومين عمل' }]]);
  const entries = await loadActiveLearnedReplies({ database, userId: 'u1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].keyword, 'كم يستغرق الشحن؟');
  assert.match(entries[0].reply, /كم يستغرق الشحن؟/);
  assert.match(entries[0].reply, /يومين عمل/);
});

test('loadActiveLearnedReplies returns [] when the feature flag is off', async () => {
  const prev = process.env.LEARNED_REPLIES_ENABLED;
  process.env.LEARNED_REPLIES_ENABLED = 'false';
  try {
    const database = fakeDbCapture([[{ question: 'س', answer: 'ج' }]]);
    assert.deepEqual(await loadActiveLearnedReplies({ database, userId: 'u1' }), []);
  } finally {
    if (prev === undefined) delete process.env.LEARNED_REPLIES_ENABLED;
    else process.env.LEARNED_REPLIES_ENABLED = prev;
  }
});

// ── server wiring: routes + periodic loop

test('server registers learned-replies routes and starts the learning loop', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(serverSource, /\/api\/learned-replies/, 'list route must exist');
  assert.match(serverSource, /\/api\/learned-replies\/toggle/, 'toggle route must exist');
  assert.match(serverSource, /startLearningLoop/, 'learning loop must be started');
  assert.match(serverSource, /LEARNING_PASS_INTERVAL_MS/, 'interval must be env-tunable');
});

// ── runLearningPass orchestration

test('runLearningPass walks users with recent owner replies and saves filtered pairs', async () => {
  const calls = [];
  const database = {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/DISTINCT user_id/i.test(sql)) return { rows: [{ user_id: 'u1' }] };
      if (/LATERAL/i.test(sql)) {
        return { rows: [{
          owner_message_id: 'om1', conversation_id: 'c1',
          answer: 'الشحن يومين عمل وبرسوم 25 ريال',
          question_message_id: 'im1', question: 'كم يستغرق الشحن للرياض؟',
        }] };
      }
      if (/SELECT COUNT/i.test(sql)) return { rows: [{ n: '0' }] };
      return { rows: [] };
    },
  };
  const result = await runLearningPass({ database });
  assert.equal(result.users, 1);
  assert.equal(result.learned, 1);
});
