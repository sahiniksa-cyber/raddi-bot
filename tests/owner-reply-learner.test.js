'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLearnablePair,
  normalizeQuestion,
  extractLearnablePairs,
  saveLearnedReplies,
  loadActiveLearnedReplies,
  updateLearnedReply,
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

test('isLearnablePair rejects pure small-talk (greetings + pleasantries carry no store knowledge)', () => {
  // The exact production case that slipped through (2026-06-11):
  assert.equal(isLearnablePair('السلام عليكم كيفك ؟', 'وعليكم السلام بخير طمني عنك'), false, 'greeting question + courtesy answer');
  assert.equal(isLearnablePair('صباح الخير شخبارك', 'صباح النور تمام الحمدلله'), false, 'morning small talk');
  assert.equal(isLearnablePair('هلا والله كيف الحال', 'اهلين حياك الله تمام'), false, 'casual small talk');
  // Greeting + a REAL question must stay learnable:
  assert.equal(isLearnablePair('السلام عليكم كم سعر اشتراك السنة؟', 'سعر اشتراك السنة 250 ريال'), true, 'greeting followed by real content');
  // Real question with a courtesy-flavored but informative answer stays learnable:
  assert.equal(isLearnablePair('متى يوصل الطلب للدمام؟', 'حياك الله، يوصل خلال ثلاثة ايام عمل'), true);
});

test('isLearnablePair rejects short/greeting/media/escalation content', () => {
  assert.equal(isLearnablePair('هلا', 'الشحن يومين عمل للرياض'), false, 'short question');
  assert.equal(isLearnablePair('كم يستغرق الشحن للرياض؟', 'تم'), false, 'short answer');
  assert.equal(isLearnablePair('[صورة من العميل]', 'الشحن يومين عمل للرياض'), false, 'media placeholder question');
  assert.equal(isLearnablePair('متى يوصل الطلب للرياض؟', '[رسالة صوتية من العميل]'), false, 'voice-note placeholder answer');
  assert.equal(isLearnablePair('[رسالة صوتية من العميل]', 'يوصل خلال يومين عمل'), false, 'voice-note placeholder question');
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

// ── updateLearnedReply: owner edits saved Q→A from the dashboard

test('updateLearnedReply updates text and recomputes the dedup key, scoped to the user', async () => {
  const calls = [];
  const database = {
    isConfigured: () => true,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
  };
  const result = await updateLearnedReply({
    database, userId: 'u1', id: '7',
    question: 'كم يستغرق الشحن؟', answer: 'يومين عمل لكل المدن',
  });
  assert.equal(result.updated, 1);
  assert.match(calls[0].sql, /UPDATE learned_replies/);
  assert.match(calls[0].sql, /normalized_question/);
  assert.match(calls[0].sql, /WHERE user_id = \$1 AND id = \$2/);
  assert.equal(calls[0].params[4], normalizeQuestion('كم يستغرق الشحن؟'));
});

test('updateLearnedReply rejects empty input without touching the DB', async () => {
  const calls = [];
  const database = { isConfigured: () => true, query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 1 }; } };
  const r1 = await updateLearnedReply({ database, userId: 'u1', id: '7', question: '  ', answer: 'جواب' });
  const r2 = await updateLearnedReply({ database, userId: 'u1', id: '7', question: 'سؤال', answer: '' });
  assert.equal(r1.updated, 0);
  assert.equal(r2.updated, 0);
  assert.equal(calls.length, 0);
});

test('updateLearnedReply reports a duplicate question instead of throwing', async () => {
  const database = {
    isConfigured: () => true,
    query: async () => { throw new Error('duplicate key value violates unique constraint "learned_replies_user_id_normalized_question_key"'); },
  };
  const result = await updateLearnedReply({ database, userId: 'u1', id: '7', question: 'سؤال مكرر هنا', answer: 'جواب ما' });
  assert.equal(result.updated, 0);
  assert.equal(result.reason, 'duplicate_question');
});

// ── server wiring: routes + periodic loop

test('server registers learned-replies routes and starts the learning loop', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(serverSource, /\/api\/learned-replies/, 'list route must exist');
  assert.match(serverSource, /\/api\/learned-replies\/toggle/, 'toggle route must exist');
  assert.match(serverSource, /\/api\/learned-replies\/update/, 'update route must exist');
  assert.match(serverSource, /startLearningLoop/, 'learning loop must be started');
  assert.match(serverSource, /LEARNING_PASS_INTERVAL_MS/, 'interval must be env-tunable');
});

// ── runLearningPass orchestration

test('runLearningPass saves a pair ONLY when its question is frequent (>=3 distinct customers)', async () => {
  const calls = [];
  const database = {
    calls,
    isConfigured: () => true,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/DISTINCT user_id/i.test(sql)) return { rows: [{ user_id: 'u1' }] };
      // frequency scan: the SAME question asked by 3 DISTINCT conversations → frequent
      if (/content IS NOT NULL/i.test(sql)) {
        return { rows: [
          { conversation_id: 'c1', content: 'كم يستغرق الشحن للرياض؟' },
          { conversation_id: 'c2', content: 'كم يستغرق الشحن للرياض؟' },
          { conversation_id: 'c3', content: 'كم يستغرق الشحن للرياض؟' },
        ] };
      }
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

test('runLearningPass does NOT save a one-off question (not frequent)', async () => {
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      if (/DISTINCT user_id/i.test(sql)) return { rows: [{ user_id: 'u1' }] };
      // frequency scan returns the question from only ONE conversation → not frequent
      if (/content IS NOT NULL/i.test(sql)) return { rows: [{ conversation_id: 'c1', content: 'كم يستغرق الشحن للرياض؟' }] };
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
  assert.equal(result.learned, 0);
});

test('runLearningPass skips a user who turned self-learning OFF (config.learningEnabled=false)', async () => {
  let sawLateral = false;
  const database = {
    isConfigured: () => true,
    query: async (sql) => {
      if (/DISTINCT user_id/i.test(sql)) return { rows: [{ user_id: 'u1' }] };
      if (/config->>'learningEnabled'/.test(sql)) return { rows: [{ v: 'false' }] };
      if (/LATERAL/i.test(sql)) { sawLateral = true; return { rows: [] }; }
      return { rows: [] };
    },
  };
  const result = await runLearningPass({ database });
  assert.equal(result.learned, 0);
  assert.equal(sawLateral, false, 'must not even extract pairs for a disabled user');
});
