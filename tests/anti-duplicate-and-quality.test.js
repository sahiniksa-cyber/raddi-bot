'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const aiWorkerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
const aiClientSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');

// ---- B1: anti-duplicate ordering ----

test('B1: inbound is marked answered BEFORE the customer-reply enqueue', () => {
  const answeredIdx = aiWorkerSrc.indexOf('await markInboundMessagesAnswered({');
  const enqueueIdx = aiWorkerSrc.indexOf('await enqueueOutgoingWhatsapp({');
  assert.ok(answeredIdx > 0 && enqueueIdx > 0, 'both calls must exist');
  assert.ok(
    answeredIdx < enqueueIdx,
    'markInboundMessagesAnswered must run BEFORE enqueueOutgoingWhatsapp so a crash/retry cannot regenerate a duplicate',
  );
});

test('B/Path3: the final-attempt fallback is guarded so it never lands on top of a real reply', () => {
  assert.match(aiWorkerSrc, /let outgoingEnqueued = false/);
  assert.match(aiWorkerSrc, /outgoingEnqueued = true/);
  assert.match(aiWorkerSrc, /isFinalAttempt && !outgoingEnqueued/);
});

// ---- C: conversational-quality runtime rules (injected on every reply) ----

test('C: runtime prompt forbids the repeated filler closers', () => {
  assert.match(aiClientSrc, /تأمر بشي ثاني/);
  assert.match(aiClientSrc, /إلا إذا كان هناك خطوة بيع/);
});

test('C: runtime prompt detects customer resolution and closes without a follow-up question', () => {
  assert.match(aiClientSrc, /اعتبر طلبه مُنجزاً/);
  assert.match(aiClientSrc, /بدون أي سؤال متابعة/);
});

test('C: runtime prompt forbids repeating the same sentence/info within a reply', () => {
  assert.match(aiClientSrc, /لا تكرر نفس الجملة أو المعلومة داخل الرد/);
});

test('C: runtime prompt tells it to act like a human (no methodology/tags/char-limit leaks)', () => {
  assert.match(aiClientSrc, /تصرّف كموظف بشري حقيقي/);
});
