'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');
const { canonicalConfig } = require('./helpers/canonical-config');

function createClient(config) {
  return new AIClient(
    { ...DEFAULT_CONFIG, ...canonicalConfig(), ...config },
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {} },
  );
}

// The owner's complaint: the bot re-delivers the SAME information it already gave,
// just reworded ("يعيدها بصياغات مختلفة"). The old rule only banned repeating
// "بنفس الصياغة" (same wording) — which literally PERMITTED reworded repetition.
// The rule must forbid repeating the same information/idea in ANY wording.
test('prompt forbids repeating already-said information even when reworded', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'تمام' }], {});
  assert.match(prompt, /بصياغة مختلفة/, 'must explicitly cover reworded repetition');
  assert.match(prompt, /لا تُعِد|لا تعيد/, 'must forbid re-delivering prior info');
});

test('prompt no longer contains the loophole that only bans same-wording repetition', () => {
  const ai = createClient({});
  const prompt = ai.buildSystemPrompt([{ role: 'user', content: 'تمام' }], {});
  assert.doesNotMatch(
    prompt,
    /في ردودك السابقة بنفس الصياغة\./,
    'the permissive "بنفس الصياغة" rule must be replaced',
  );
});

test('reworded-repetition rule also appears in the long-custom-instructions path', () => {
  const ai = createClient({ botInstructions: 'تعليمات المالك '.repeat(40) });
  const prompt = ai.buildSystemPrompt([], {});
  assert.match(prompt, /بصياغة مختلفة/);
});
