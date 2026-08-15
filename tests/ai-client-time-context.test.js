'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIClient = require('../lib/ai-client');

const NULL_LOG = { info() {}, warn() {}, error() {} };
const NOW = new Date('2026-08-15T18:30:00Z'); // 21:30 Riyadh / 22:30 Dubai

function client(overrides) {
  return new AIClient({ storeName: 'متجر', model: 'gpt-4o', openaiApiKey: 'x', ...overrides }, NULL_LOG, { record() {} });
}

// History carries per-message timestamps (ts) as ai-history now provides.
const HISTORY = [
  { role: 'user', content: 'متى يتفعل؟', ts: new Date('2026-08-15T17:10:00Z') },   // 20:10 Riyadh
  { role: 'assistant', content: 'عادة خلال ساعات', ts: new Date('2026-08-15T17:11:00Z') }, // 20:11
  { role: 'user', content: 'للحين ما تفعل', ts: new Date('2026-08-15T18:25:00Z') }, // 21:25
];

test('P1: current-time block + per-message clock prefixes reach the model (Riyadh tenant)', () => {
  const msgs = client({ timezone: 'Asia/Riyadh' }).composeMessages(HISTORY, { now: NOW });
  const system = msgs[0].content;
  assert.match(system, /الوقت الحالي: 2026-08-15 21:30/);
  assert.equal(msgs[1].content, '[20:10] متى يتفعل؟');
  assert.equal(msgs[2].content, '[20:11] عادة خلال ساعات');
  assert.equal(msgs[3].content, '[21:25] للحين ما تفعل');
  // Only role+content go to the API — no leaked ts field.
  assert.deepEqual(Object.keys(msgs[1]).sort(), ['content', 'role']);
});

test('P1: SAME conversation renders in each tenant timezone (multi-tenant, no leak)', () => {
  const riyadh = client({ timezone: 'Asia/Riyadh' }).composeMessages(HISTORY, { now: NOW });
  const dubai = client({ timezone: 'Asia/Dubai' }).composeMessages(HISTORY, { now: NOW });
  assert.match(riyadh[0].content, /21:30/);
  assert.match(dubai[0].content, /22:30/);
  assert.equal(riyadh[1].content, '[20:10] متى يتفعل؟');
  assert.equal(dubai[1].content, '[21:10] متى يتفعل؟'); // +1h in Dubai
  assert.notEqual(riyadh[1].content, dubai[1].content);
});

test('P1: a message without a reliable timestamp is NOT given a fabricated time', () => {
  const msgs = client({ timezone: 'Asia/Riyadh' }).composeMessages(
    [{ role: 'user', content: 'رسالة قديمة بلا وقت', ts: null }],
    { now: NOW },
  );
  assert.equal(msgs[1].content, 'رسالة قديمة بلا وقت'); // no [HH:MM] invented
});

// Explicit P1 two-tenant requirement: different timezone AND different SLA.
const { computeSlaBreach } = require('../src/services/instruction-routing/sla-breach');
const { resolveTrustedEventTimestamp } = require('../src/services/ai/trusted-event-time');
const HOUR_MS = 3600 * 1000;

test('P1: two tenants — different timezone AND different SLA policy, computed per tenant', () => {
  const since = new Date(NOW.getTime() - 25 * HOUR_MS); // request registered 25h ago

  // Store A: Riyadh, SLA 12h → breached at 25h.
  const storeA = { timezone: 'Asia/Riyadh', slaPolicies: [{ amount: 12, unit: 'ساعة' }] };
  // Store B: Dubai, SLA 3 days → NOT breached at 25h.
  const storeB = { timezone: 'Asia/Dubai', slaPolicies: [{ amount: 3, unit: 'أيام' }] };

  const anchor = resolveTrustedEventTimestamp({ escalation_thread_created_at: since });
  assert.equal(anchor.source, 'escalation_thread_created_at');

  const aBreach = computeSlaBreach({ since: anchor.timestamp, now: NOW.getTime(), slaPolicies: storeA.slaPolicies });
  const bBreach = computeSlaBreach({ since: anchor.timestamp, now: NOW.getTime(), slaPolicies: storeB.slaPolicies });
  assert.equal(aBreach.sla_breached, true, 'Store A (12h) breached');
  assert.equal(bBreach.sla_breached, false, 'Store B (3d) not breached');

  // And the clock rendering differs by tenant timezone.
  const aMsgs = client(storeA).composeMessages(HISTORY, { now: NOW });
  const bMsgs = client(storeB).composeMessages(HISTORY, { now: NOW });
  assert.match(aMsgs[0].content, /21:30/);
  assert.match(bMsgs[0].content, /22:30/);
});
