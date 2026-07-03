'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Test that the default AI reply debounce window is 30s (raised from 20s on
// 2026-07-02 to better group a customer's consecutive messages into one reply).
// We delete the env var to ensure we're testing the hardcoded default, then
// force a fresh module load with a cache-bust so the module-level constant
// re-evaluates.

test('resolveDebounceMs returns 30000 when AI_REPLY_DEBOUNCE_MS is unset', () => {
  const saved = process.env.AI_REPLY_DEBOUNCE_MS;
  delete process.env.AI_REPLY_DEBOUNCE_MS;

  // Clear module cache so the module-level constant re-evaluates from env.
  const modulePath = require.resolve('../src/queues/message-queue');
  delete require.cache[modulePath];

  try {
    const { resolveDebounceMs } = require('../src/queues/message-queue');
    assert.equal(
      resolveDebounceMs(),
      30000,
      'Default debounce must be 30000 ms when AI_REPLY_DEBOUNCE_MS is unset',
    );
  } finally {
    // Restore env and evict again so other tests see a clean state.
    if (saved !== undefined) {
      process.env.AI_REPLY_DEBOUNCE_MS = saved;
    }
    delete require.cache[require.resolve('../src/queues/message-queue')];
  }
});

test('resolveDebounceMs honours AI_REPLY_DEBOUNCE_MS when set', () => {
  const saved = process.env.AI_REPLY_DEBOUNCE_MS;
  process.env.AI_REPLY_DEBOUNCE_MS = '5000';

  const modulePath = require.resolve('../src/queues/message-queue');
  delete require.cache[modulePath];

  try {
    const { resolveDebounceMs } = require('../src/queues/message-queue');
    assert.equal(
      resolveDebounceMs(),
      5000,
      'resolveDebounceMs must honour AI_REPLY_DEBOUNCE_MS env var',
    );
  } finally {
    if (saved !== undefined) {
      process.env.AI_REPLY_DEBOUNCE_MS = saved;
    } else {
      delete process.env.AI_REPLY_DEBOUNCE_MS;
    }
    delete require.cache[require.resolve('../src/queues/message-queue')];
  }
});

// Source-level assertion: ai-worker.js must NOT contain '|| \'9000\'' near a
// debounce constant, and the enqueueFollowupIfPending default must use
// resolveDebounceMs() so both initial and follow-up enqueues share the same
// 20 s window.
test('ai-worker.js follow-up path uses resolveDebounceMs() — no stale 9000 default', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/workers/ai-worker.js'),
    'utf8',
  );

  assert.ok(
    !src.includes("|| '9000'"),
    "ai-worker.js must not contain the stale 9000 ms debounce default (|| '9000')",
  );
  assert.ok(
    src.includes('debounceMs = resolveDebounceMs()'),
    "enqueueFollowupIfPending must default debounceMs to resolveDebounceMs()",
  );
  assert.ok(
    src.includes('resolveDebounceMs') && src.includes("require('../queues/message-queue')"),
    "resolveDebounceMs must be imported from message-queue",
  );
});

test('buildAiReplyQueueOptions uses 30000 as default delay for debounced jobs', () => {
  const saved = process.env.AI_REPLY_DEBOUNCE_MS;
  delete process.env.AI_REPLY_DEBOUNCE_MS;

  const modulePath = require.resolve('../src/queues/message-queue');
  delete require.cache[modulePath];

  try {
    const { buildAiReplyQueueOptions } = require('../src/queues/message-queue');
    const opts = buildAiReplyQueueOptions({ conversationId: 'conv-123', messageId: 'msg-1' });
    assert.equal(
      opts.delay,
      30000,
      `Default debounce delay must be 30000 ms, got ${opts.delay}`,
    );
  } finally {
    if (saved !== undefined) {
      process.env.AI_REPLY_DEBOUNCE_MS = saved;
    }
    delete require.cache[require.resolve('../src/queues/message-queue')];
  }
});
