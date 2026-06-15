'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { DEFAULT_CONFIG } = require('../lib/constants');

const OPENAI_KEY = 'sk-' + 'x'.repeat(48);
const OR_KEY = 'sk-or-' + 'y'.repeat(48);
const GOOGLE_KEY = 'AIza' + 'z'.repeat(30);

function isGeminiModel(m) {
  return String(m).startsWith('google/') || String(m).startsWith('gemini');
}
function isOpenAIRoutable(m) {
  return !String(m).includes('/') || String(m).startsWith('openai/');
}

test('resolveEffectiveModel: Gemini default + only an OpenAI key → an OpenAI model (not Gemini)', () => {
  const m = AIClient.resolveEffectiveModel({ model: 'google/gemini-2.0-flash', openaiApiKey: OPENAI_KEY });
  assert.ok(!isGeminiModel(m), `expected a non-Gemini model, got ${m}`);
  assert.ok(isOpenAIRoutable(m), `expected an OpenAI-routable model, got ${m}`);
});

test('resolveEffectiveModel: an OpenRouter key keeps the configured model (it routes everything)', () => {
  const m = AIClient.resolveEffectiveModel({ model: 'google/gemini-2.0-flash', openrouterApiKey: OR_KEY });
  assert.equal(m, 'google/gemini-2.0-flash');
});

test('resolveEffectiveModel: a Google key keeps Gemini', () => {
  const m = AIClient.resolveEffectiveModel({ model: 'google/gemini-2.0-flash', googleApiKey: GOOGLE_KEY });
  assert.equal(m, 'google/gemini-2.0-flash');
});

test('resolveEffectiveModel: an explicit OpenAI model + an OpenAI key is kept as-is', () => {
  const m = AIClient.resolveEffectiveModel({ model: 'gpt-4o', openaiApiKey: OPENAI_KEY });
  assert.equal(m, 'gpt-4o');
});

test('buildClient does NOT throw when the model is the Gemini default but only an OpenAI key exists', () => {
  const ai = new AIClient(
    { model: 'google/gemini-2.0-flash', openaiApiKey: OPENAI_KEY },
    { info() {}, warn() {}, error() {} },
    { record() {}, save() {} },
  );
  const built = ai.buildClient();
  assert.ok(built && built.openai, 'should build a usable client');
  assert.ok(!isGeminiModel(built.model), `expected OpenAI routing, got ${built.model}`);
});

test('DEFAULT_CONFIG.model is NOT Gemini (matches the platform OpenAI key by default)', () => {
  assert.ok(!isGeminiModel(DEFAULT_CONFIG.model), `default model should not be Gemini, got ${DEFAULT_CONFIG.model}`);
});
