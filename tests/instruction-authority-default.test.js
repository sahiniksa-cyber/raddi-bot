'use strict';

// §2/§10 — Instruction Authority is PLATFORM behavior by DEFAULT (no flag needed).
// A long legacy botInstructions must never become the dominating prompt base; it
// is shadow-routed into a subordinate persona + an authoritative tenant-facts
// block, with NOTHING lost. The ONLY way back to the legacy blob-as-base is the
// explicit kill-switch BOUNDED_BOT_INSTRUCTIONS_ENABLED=false.
const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

// ≥80 chars so it takes the "long instructions" path (the case the owner worried
// about). Mixes the three §10 kinds: STYLE + operational escalation + prohibition.
const LEGACY = 'تكلم مع العميل بلهجة سعودية خفيفة ومختصرة وواضحة دائماً. أي مشكلة أو عطل يواجه العميل في الخدمة صعّدها فوراً للدعم. لا تطول في الرد أبداً.';

function build(env) {
  const prev = process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  if (env === undefined) delete process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
  else process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = env;
  try {
    const c = new AIClient(
      { storeName: 'متجر أ', botInstructions: LEGACY, escalationContacts: [{ name: 'الدعم', phone: '966500000001' }] },
      { info() {}, warn() {}, error() {} },
    );
    return c.buildSystemPrompt([{ role: 'user', content: 'السلام عليكم عندي مشكلة' }], {});
  } finally {
    if (prev === undefined) delete process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED;
    else process.env.BOUNDED_BOT_INSTRUCTIONS_ENABLED = prev;
  }
}

test('DEFAULT (flag unset): legacy blob is NOT the prompt base', () => {
  const sys = build(undefined);
  assert.ok(!sys.startsWith(LEGACY.slice(0, 20)), 'blob must not be the base by default');
  assert.ok(sys.includes('في متجر متجر أ'), 'structured platform base present');
  assert.ok(sys.includes('<شخصية_وأسلوب_الموظف>'), 'subordinate persona block present');
});

test('DEFAULT: style → persona, escalation directive → authoritative facts (nothing lost)', () => {
  const sys = build(undefined);
  const personaStart = sys.indexOf('<شخصية_وأسلوب_الموظف>');
  const personaEnd = sys.indexOf('</شخصية_وأسلوب_الموظف>');
  const persona = sys.slice(personaStart, personaEnd);
  assert.ok(/سعودي/.test(persona), 'style stays in persona');
  assert.ok(!/صعّدها للدعم/.test(persona), 'operational escalation must NOT live in persona');
  assert.ok(sys.includes('<معلومات_وسياسات_التاجر>'), 'tenant-facts block present');
  assert.ok(/صعّد|صعد/.test(sys.slice(sys.indexOf('<معلومات_وسياسات_التاجر>'))), 'escalation directive preserved as a fact');
});

test('kill-switch =false → legacy blob-as-base restored (rollback)', () => {
  const sys = build('false');
  assert.ok(sys.startsWith(LEGACY.slice(0, 20)), 'legacy path starts with raw blob');
  assert.ok(!sys.includes('<شخصية_وأسلوب_الموظف>'), 'no persona wrapper in legacy mode');
});
