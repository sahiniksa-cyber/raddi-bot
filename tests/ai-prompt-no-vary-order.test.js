'use strict';
// Legacy-path regression lock: asserts the CURRENT (default) prompt wording.
// Pin the style/brevity flags OFF so this file deterministically tests the
// legacy path regardless of ambient env. New-path behavior is locked in
// tests/reply-voice-newpath-locks.test.js.
process.env.PROMPT_STYLE_SPLIT_ENABLED = "false";
delete process.env.BREVITY_AUTHORITY_ENABLED;
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

test('prompt no longer ORDERS lexical variation', () => {
  const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
  const sys = c.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم' }], {});
  assert.ok(!/نوّع صياغتك/.test(sys), 'must not order the model to vary its wording');
  assert.ok(/كموظف بشري|موظف بشري/.test(sys), 'must still tell it to act like a human employee');
});
