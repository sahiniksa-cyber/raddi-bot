'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Try to load the module. If the sibling agent hasn't written it yet, we
// surface a single failing test that explains the situation instead of
// blowing up at require-time and aborting the whole runner.
let metaPrompts;
let loadError;
try {
  metaPrompts = require('../src/services/ai/meta-prompts');
} catch (err) {
  loadError = err;
}

if (loadError) {
  test('meta-prompts module is available', () => {
    assert.fail(
      `src/services/ai/meta-prompts.js could not be loaded yet: ${loadError.message}`,
    );
  });
  return;
}

const {
  buildTrainAnalyzeRequest,
  buildEnhanceInstructionsRequest,
  buildLearnStyleRequest,
} = metaPrompts;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnswers(count) {
  const rows = [
    { q: 'مين عميلك المثالي؟', a: 'تاجر صغير من السعودية' },
    { q: 'كيف ترحب؟', a: 'هلا والله، تأمر بأي شي؟' },
  ];
  while (rows.length < count) {
    rows.push({ q: `سؤال رقم ${rows.length + 1}؟`, a: `جواب رقم ${rows.length + 1}` });
  }
  return rows.slice(0, count);
}

function assertRequestShape(req) {
  assert.ok(req && typeof req === 'object', 'request should be an object');
  assert.ok(Array.isArray(req.messages), 'messages should be an array');
  assert.equal(req.messages.length, 2, 'expected exactly 2 messages (system + user)');
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[1].role, 'user');
  assert.ok(typeof req.messages[0].content === 'string' && req.messages[0].content.length > 0);
  assert.ok(typeof req.messages[1].content === 'string');
  assert.ok(typeof req.temperature === 'number');
  assert.ok(req.temperature >= 0 && req.temperature <= 1, 'temperature out of [0,1]');
  assert.ok(typeof req.maxTokens === 'number' && req.maxTokens >= 1500);
}

// ---------------------------------------------------------------------------
// buildTrainAnalyzeRequest
// ---------------------------------------------------------------------------

test('train-analyze: returns valid messages array', () => {
  const req = buildTrainAnalyzeRequest({
    answers: makeAnswers(23),
    storeName: 'ProStoree',
  });
  assertRequestShape(req);
});

test('train-analyze: system message mentions 6-block structure', () => {
  const req = buildTrainAnalyzeRequest({ answers: [], storeName: 's' });
  const sys = req.messages[0].content;
  for (const tag of [
    'identity',
    'persona_tone',
    'scope',
    'refusal_policy',
    'output_format',
    'critical_rules',
    'examples',
  ]) {
    assert.ok(sys.includes(tag), `system prompt missing block: ${tag}`);
  }
});

test('train-analyze: system message references HEARD framework', () => {
  const req = buildTrainAnalyzeRequest({ answers: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /HEARD/i.test(sys) || /Hear.*Empathize.*Apologize.*Resolve.*Diagnose/i.test(sys),
    'HEARD framework not referenced',
  );
});

test('train-analyze: system message mentions Saudi dialect', () => {
  const req = buildTrainAnalyzeRequest({ answers: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(/لهجة|سعودي|نجدي|حجازي|خليجي/.test(sys), 'Saudi dialect not mentioned');
});

test('train-analyze: system message bans AI/bot mention in output', () => {
  const req = buildTrainAnalyzeRequest({ answers: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /لا تذكر.*AI|ممنوع.*AI|لا تذكر.*بوت|ممنوع.*بوت/i.test(sys),
    'system prompt does not forbid AI/bot mentions in output',
  );
});

test('train-analyze: user message contains the answers', () => {
  const answers = [{ q: 'سؤال؟', a: 'جواب' }];
  const req = buildTrainAnalyzeRequest({ answers, storeName: 's' });
  assert.ok(req.messages[1].content.includes('سؤال؟'));
  assert.ok(req.messages[1].content.includes('جواب'));
});

test('train-analyze: storeName is injected', () => {
  const req = buildTrainAnalyzeRequest({ answers: [], storeName: 'ProStoree' });
  const combined = req.messages[0].content + req.messages[1].content;
  assert.ok(combined.includes('ProStoree'), 'storeName not propagated into prompt');
});

// ---------------------------------------------------------------------------
// buildEnhanceInstructionsRequest
// ---------------------------------------------------------------------------

test('enhance-instructions: returns valid messages', () => {
  const req = buildEnhanceInstructionsRequest({
    currentText: 'ابيك ترد بلهجة سعودية وما تذكر اسعار',
    storeName: 'متجري',
  });
  assertRequestShape(req);
  assert.ok(req.messages[1].content.includes('ابيك ترد بلهجة سعودية'));
});

test('enhance-instructions: system mentions XML blocks', () => {
  const req = buildEnhanceInstructionsRequest({ currentText: 'x', storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(sys.includes('identity'));
  assert.ok(sys.includes('persona_tone'));
  assert.ok(sys.includes('examples'));
});

test('enhance-instructions: instructs not to invent info', () => {
  const req = buildEnhanceInstructionsRequest({ currentText: 'x', storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /لا تخترع|لا تضف|بدون اختراع|placeholder/i.test(sys),
    'system prompt does not warn against fabrication',
  );
});

test('enhance-instructions: instructs to add forbidden_words if missing', () => {
  const req = buildEnhanceInstructionsRequest({ currentText: 'x', storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /forbidden_words|للأسف|مستحيل|ما أقدر/i.test(sys),
    'system prompt does not mention forbidden_words guidance',
  );
});

// ---------------------------------------------------------------------------
// buildLearnStyleRequest
// ---------------------------------------------------------------------------

test('learn-style: returns valid messages', () => {
  const req = buildLearnStyleRequest({
    samples: ['هلا والله', 'تمام، أرسلك الحين', 'في خدمتك'],
    storeName: 's',
  });
  assertRequestShape(req);
  assert.ok(req.messages[1].content.includes('هلا والله'));
});

test('learn-style: system instructs to return 3 XML blocks (persona_tone, style_signature, examples)', () => {
  const req = buildLearnStyleRequest({ samples: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(sys.includes('persona_tone'));
  assert.ok(sys.includes('style_signature') || sys.includes('signature'));
  assert.ok(sys.includes('examples'));
});

test('learn-style: instructs to detect dialect (نجدي/حجازي/etc)', () => {
  const req = buildLearnStyleRequest({ samples: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /نجدي|حجازي|شرقاوي|خليجي|لهجة/.test(sys),
    'dialect detection instruction missing',
  );
});

test('learn-style: instructs to use literal quotes from samples', () => {
  const req = buildLearnStyleRequest({ samples: [], storeName: 's' });
  const sys = req.messages[0].content;
  assert.ok(
    /اقتباس|حرفي|verbatim|اقتبس/i.test(sys),
    'verbatim/quote instruction missing',
  );
});

// ---------------------------------------------------------------------------
// Defensive / cross-cutting
// ---------------------------------------------------------------------------

test('all three: do not throw on empty input', () => {
  assert.doesNotThrow(() =>
    buildTrainAnalyzeRequest({ answers: [], storeName: '' }),
  );
  assert.doesNotThrow(() =>
    buildEnhanceInstructionsRequest({ currentText: '', storeName: '' }),
  );
  assert.doesNotThrow(() =>
    buildLearnStyleRequest({ samples: [], storeName: '' }),
  );
});

test('all three: maxTokens reasonable for sysprompt generation', () => {
  const a = buildTrainAnalyzeRequest({ answers: [], storeName: '' });
  const b = buildEnhanceInstructionsRequest({ currentText: '', storeName: '' });
  const c = buildLearnStyleRequest({ samples: [], storeName: '' });
  for (const r of [a, b, c]) {
    assert.ok(r.maxTokens >= 1200, 'maxTokens too low for multi-block output');
    assert.ok(r.maxTokens <= 4000, 'maxTokens unreasonably high');
  }
});
