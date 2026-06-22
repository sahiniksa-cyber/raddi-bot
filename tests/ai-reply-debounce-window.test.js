'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Test that the default AI reply debounce window is 20s.
// We delete the env var to ensure we're testing the hardcoded default, then
// force a fresh module load with a cache-bust so the module-level constant
// re-evaluates.

test('resolveDebounceMs returns 20000 when AI_REPLY_DEBOUNCE_MS is unset', () => {
  const saved = process.env.AI_REPLY_DEBOUNCE_MS;
  delete process.env.AI_REPLY_DEBOUNCE_MS;

  // Clear module cache so the module-level constant re-evaluates from env.
  const modulePath = require.resolve('../src/queues/message-queue');
  delete require.cache[modulePath];

  try {
    const { resolveDebounceMs } = require('../src/queues/message-queue');
    assert.equal(
      resolveDebounceMs(),
      20000,
      'Default debounce must be 20000 ms when AI_REPLY_DEBOUNCE_MS is unset',
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

test('buildAiReplyQueueOptions uses 20000 as default delay for debounced jobs', () => {
  const saved = process.env.AI_REPLY_DEBOUNCE_MS;
  delete process.env.AI_REPLY_DEBOUNCE_MS;

  const modulePath = require.resolve('../src/queues/message-queue');
  delete require.cache[modulePath];

  try {
    const { buildAiReplyQueueOptions } = require('../src/queues/message-queue');
    const opts = buildAiReplyQueueOptions({ conversationId: 'conv-123', messageId: 'msg-1' });
    assert.equal(
      opts.delay,
      20000,
      `Default debounce delay must be 20000 ms, got ${opts.delay}`,
    );
  } finally {
    if (saved !== undefined) {
      process.env.AI_REPLY_DEBOUNCE_MS = saved;
    }
    delete require.cache[require.resolve('../src/queues/message-queue')];
  }
});
