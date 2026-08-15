'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Wiring tests for the Instruction Routing reply-time consumption (#177):
//   Gap A — a stored escalationRule that MATCHES the inbound (and resolves to a
//           real contact) must fire the REAL escalation machinery at reply time,
//           behind INSTRUCTION_ROUTING_ENABLED, without relying on the LLM to emit
//           [تحويل:]. Flag OFF → no rule-driven escalation.
//   Gap B — a computed SLA breach (reliable escalation-thread timestamp + a
//           parseable slaPolicy) must reach ai.getReply as opts.slaBreach so the
//           breach block is injected. Flag OFF → no slaBreach.

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let pendingSince = null; // Date | null
let botConfig = {};
const HOUR = 3600 * 1000;

const dbMock = {
  isConfigured: () => true,
  async query(sql) {
    const s = String(sql);
    if (s.includes('FROM conversations') && s.includes('WHERE id = $1') && s.includes('user_id = $2') && !s.includes('escalated_until')) {
      return { rows: [{ id: 'conv-1', sender: '966500000000@s.whatsapp.net', phone_number: '966500000000' }], rowCount: 1 };
    }
    if (s.includes('escalated_until') && s.includes('escalated_until > NOW()')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('FROM messages') && s.includes("direction = 'inbound'") && s.includes('WHERE id = $1') && s.includes('user_id = $2')) {
      return { rows: [{ content: 'أبغى أستفسر عن سياسة الاسترجاع' }], rowCount: 1 };
    }
    if (s.includes('last_assistant') && s.includes("status IN ('queued_for_ai', 'ai_failed')")) {
      return { rows: [{ id: 'inbound-1', content: 'أبغى أستفسر عن سياسة الاسترجاع', provider_message_id: 'p-in-1', raw_payload: {}, inbound_seq: 5 }], rowCount: 1 };
    }
    if (s.includes('SELECT role, content, status, direction')) {
      return { rows: [{ role: 'user', content: 'أبغى أستفسر عن سياسة الاسترجاع', status: 'queued_for_ai', direction: 'inbound' }], rowCount: 1 };
    }
    // getPendingEscalation
    if (s.includes('escalation_threads') && s.includes('resolved_at IS NULL')) {
      return pendingSince ? { rows: [{ created_at: pendingSince }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO messages') && s.includes('RETURNING id')) {
      return { rows: [{ id: 'assistant-1' }], rowCount: 1 };
    }
    // escalation_log cooldown / stats / insert → default empty (escalation proceeds)
    return { rows: [], rowCount: 0 };
  },
  close: async () => {},
};

stub(path.resolve(__dirname, '..', 'src', 'db', 'client.js'), dbMock);
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), {
  resolveConfigForAI: async () => botConfig,
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'bot', 'platform-features.js'), {
  findAutoReply: () => null,
  collectInstantReplies: () => ({ matched: [], hasExtraQuestion: false }),
  combineCannedAndAi: (a, b) => `${a}\n${b}`,
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'billing', 'message-quota.js'), {
  checkMessageQuota: async () => ({ canReply: true, remaining: 100, reason: 'ok' }),
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'learning', 'owner-reply-learner.js'), {
  loadActiveLearnedReplies: async () => [],
});
stub(path.resolve(__dirname, '..', 'src', 'workers', 'profile-extractor.js'), {
  getProfile: async () => null,
  extractAsync: () => {},
});
stub(path.resolve(__dirname, '..', 'src', 'services', 'notify', 'mailer.js'), {
  createMailer: () => null,
});

const enqueued = [];
stub(path.resolve(__dirname, '..', 'src', 'queues', 'message-queue.js'), {
  QUEUE_NAMES: { incomingMessages: 'incoming-messages', aiReplies: 'ai-replies', outgoingWhatsapp: 'outgoing-whatsapp' },
  enqueueOutgoingWhatsapp: async (payload) => { enqueued.push(payload); return { id: `out-${enqueued.length}` }; },
  enqueueAiReply: async () => ({ id: 'ai-1' }),
});

const capturedOpts = [];
stub(path.resolve(__dirname, '..', 'lib', 'ai-client.js'), class StubAi {
  constructor() { this.lastDebug = { qualityGate: { intent: 'refund_policy' } }; }
  async getReply(history, opts = {}) {
    capturedOpts.push(opts);
    return 'سياسة الاسترجاع خلال ١٤ يوم.';
  }
});

const { processAiReply } = require('../src/workers/ai-worker');

function makeJob() {
  return {
    id: 'job-det-1',
    data: { userId: 'user-1', conversationId: 'conv-1', messageId: 'inbound-1', sender: '966500000000@s.whatsapp.net', providerMessageId: 'p-in-1' },
    attemptsMade: 0,
  };
}

function reset() {
  enqueued.length = 0;
  capturedOpts.length = 0;
  delete process.env.INSTRUCTION_ROUTING_ENABLED;
  pendingSince = null;
  botConfig = { learningEnabled: false, memoryMessages: 50 };
}

test('Gap A: matched escalationRule fires a REAL escalation when routing is ON', async () => {
  reset();
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  botConfig = {
    learningEnabled: false, memoryMessages: 50,
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
    escalationRules: [{ target_contact_id: 'name:الدعم', trigger_type: 'topic', trigger_value: 'الاسترجاع' }],
  };

  await processAiReply(makeJob());

  const escalationOut = enqueued.find((e) => e.escalation === true);
  assert.ok(escalationOut, 'a real escalation outbound should have been enqueued');
  const customerOut = enqueued.find((e) => e.source === 'ai_reply');
  assert.ok(customerOut, 'the customer reply should still be sent');
  assert.doesNotMatch(customerOut.reply, /\[تحويل:/, 'the raw marker must be scrubbed from the customer reply');
});

test('Gap A: same rule does NOT fire when routing is OFF (flag-gated)', async () => {
  reset();
  botConfig = {
    learningEnabled: false, memoryMessages: 50,
    escalationContacts: [{ name: 'الدعم', phone: '966511111111' }],
    escalationRules: [{ target_contact_id: 'name:الدعم', trigger_type: 'topic', trigger_value: 'الاسترجاع' }],
  };

  await processAiReply(makeJob());

  assert.equal(enqueued.find((e) => e.escalation === true), undefined, 'no rule-driven escalation when the flag is off');
});

test('Gap B: computed SLA breach reaches ai.getReply as opts.slaBreach when routing is ON', async () => {
  reset();
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  pendingSince = new Date(Date.now() - 25 * HOUR); // request tracked 25h ago
  botConfig = {
    learningEnabled: false, memoryMessages: 50,
    slaPolicies: [{ amount: 12, unit: 'ساعة', source_text: 'التفعيل حتى 12 ساعة' }],
  };

  await processAiReply(makeJob());

  assert.ok(capturedOpts.length >= 1, 'getReply should have been called');
  assert.ok(capturedOpts[0].slaBreach, 'slaBreach must be passed to the model');
  assert.equal(capturedOpts[0].slaBreach.sla_breached, true);
});

test('Gap B: no slaBreach passed when routing is OFF', async () => {
  reset();
  pendingSince = new Date(Date.now() - 25 * HOUR);
  botConfig = {
    learningEnabled: false, memoryMessages: 50,
    slaPolicies: [{ amount: 12, unit: 'ساعة' }],
  };

  await processAiReply(makeJob());

  assert.ok(capturedOpts.length >= 1);
  assert.ok(!capturedOpts[0].slaBreach || capturedOpts[0].slaBreach.sla_breached !== true);
});

test('Gap B: within SLA window → not breached (no false late)', async () => {
  reset();
  process.env.INSTRUCTION_ROUTING_ENABLED = 'true';
  pendingSince = new Date(Date.now() - 3 * HOUR);
  botConfig = {
    learningEnabled: false, memoryMessages: 50,
    slaPolicies: [{ amount: 12, unit: 'ساعة' }],
  };

  await processAiReply(makeJob());

  assert.ok(capturedOpts.length >= 1);
  assert.ok(!capturedOpts[0].slaBreach || capturedOpts[0].slaBreach.sla_breached !== true);
});
