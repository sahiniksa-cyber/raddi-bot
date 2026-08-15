'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const LONG = 'أنت موظف خدمة عملاء لطيف ومهذب في متجر عام. رحّب بالعميل باختصار واستخدم لهجة سعودية خفيفة، وجاوب بوضوح ودون إطالة، ونوّع صياغتك.';

function client(extra = {}) {
  return new AIClient({ storeName: 'متجري', botInstructions: LONG, ...extra }, { info() {}, warn() {}, error() {} });
}

test('flag OFF (legacy): long botInstructions is the PROMPT BASE (starts with the raw text)', () => {
  const prev = process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = 'false';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  assert.ok(sys.startsWith(LONG.slice(0, 30)), 'legacy: prompt starts with raw botInstructions');
  assert.ok(!sys.includes('<شخصية_وأسلوب_الموظف>'));
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = prev;
});

test('flag ON: botInstructions becomes a bounded, subordinate persona block — NOT the base', () => {
  const prev = process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = 'true';
  const sys = client().buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  assert.ok(!sys.startsWith(LONG.slice(0, 30)), 'must NOT start with the raw merchant text');
  assert.ok(sys.includes('أنت موظف خدمة العملاء في متجر متجري') || sys.includes('في متجر متجري'), 'structured base present');
  assert.ok(sys.includes('<شخصية_وأسلوب_الموظف>'), 'persona block present');
  assert.ok(sys.includes('المصدر الأعلى'), 'platform framed as authoritative over persona');
  assert.ok(sys.includes('قواعد الدقة'), 'platform operational rules still present');
  assert.ok(sys.includes(LONG.slice(0, 30)), 'the persona text itself is included');
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = prev;
});

test('flag ON: an oversized botInstructions is capped', () => {
  const prev = process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  const prevMax = process.env.BOT_INSTRUCTIONS_MAX_CHARS;
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = 'true';
  process.env.BOT_INSTRUCTIONS_MAX_CHARS = '200';
  const huge = 'أسلوب. '.repeat(400); // ~2800 chars
  const sys = client({ botInstructions: huge }).buildSystemPrompt([{ role: 'user', content: 'مرحبا' }], {});
  assert.ok(sys.includes('…'), 'capped with an ellipsis');
  // The persona section must be far smaller than the raw text.
  const personaStart = sys.indexOf('<شخصية_وأسلوب_الموظف>');
  const personaEnd = sys.indexOf('</شخصية_وأسلوب_الموظف>');
  assert.ok(personaEnd - personaStart < 600, 'persona section is bounded');
  process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = prev;
  process.env.BOT_INSTRUCTIONS_MAX_CHARS = prevMax;
});
