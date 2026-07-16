'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  clampLimit,
  lineFormatScenario,
  maximumPreviousAssistantSimilarity,
  reportedScenarios,
} = require('../scripts/pre-send-review-replay');

test('replay limit is bounded so a dry run cannot create an accidental large AI bill', () => {
  assert.equal(clampLimit('0'), 1);
  assert.equal(clampLimit('10'), 10);
  assert.equal(clampLimit('999'), 30);
  assert.equal(clampLimit('bad'), 10);
});

test('replay includes both user-reported screenshot failures', () => {
  const scenarios = reportedScenarios();
  assert.equal(scenarios.length, 2);
  assert.ok(scenarios.some(scenario => /كود خصم/.test(scenario.draft) && /تقسيط تمارا/.test(scenario.draft)));
  assert.ok(scenarios.some(scenario => /ورحمة الله وبركاته/.test(scenario.draft)));
});

test('replay includes a multi-sentence acceptance case for real line-format enforcement', () => {
  const scenario = lineFormatScenario();
  assert.equal(scenario.kind, 'line_format_acceptance');
  assert.ok((scenario.draft.match(/\./g) || []).length >= 2);
});

test('replay similarity reads only previous assistant turns', () => {
  const score = maximumPreviousAssistantSimilarity('لا يوجد كود خصم', [
    { role: 'user', content: 'لا يوجد كود خصم' },
    { role: 'assistant', content: 'لا يوجد كود خصم' },
  ]);
  assert.equal(score, 1);
});

test('replay script is structurally read-only and cannot send WhatsApp messages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pre-send-review-replay.js'), 'utf8');
  assert.doesNotMatch(source, /sendMessage\s*\(|sendWhatsapp|enqueueOutgoing/);
  assert.doesNotMatch(source, /\b(?:UPDATE|INSERT|DELETE)\s+(?:messages|conversations|jobs)\b/i);
});
