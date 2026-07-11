'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  shouldGenerateReply,
  shouldBlockSendForQuota,
  alreadySent,
  buildAiConfig,
} = require('../src/workers/instagram-worker');

test('alreadySent guards against double-send on retry', () => {
  assert.strictEqual(alreadySent({ status: 'sent' }), true);
  assert.strictEqual(alreadySent({ provider_message_id: 'mid.1' }), true);
  assert.strictEqual(alreadySent({ status: 'queued_for_send', provider_message_id: null }), false);
  assert.strictEqual(alreadySent(undefined), false);
});

test('shouldGenerateReply true only when AI enabled', () => {
  assert.strictEqual(shouldGenerateReply({ enabled: false }), false);
  assert.strictEqual(shouldGenerateReply({ enabled: true }), true);
  assert.strictEqual(shouldGenerateReply(null), false);
});

test('shouldBlockSendForQuota true only when canReply === false', () => {
  assert.strictEqual(shouldBlockSendForQuota({ canReply: false }), true);
  assert.strictEqual(shouldBlockSendForQuota({ canReply: true }), false);
});

test('buildAiConfig keeps Instagram behavior but injects resolved API keys', () => {
  const igConfig = { botInstructions: 'IG voice', model: 'gpt-4o', storeName: 'IG' };
  const resolved = {
    openaiApiKey: 'sk-real', openrouterApiKey: 'or', googleApiKey: 'g', anthropicApiKey: 'a',
    model: 'gpt-4o-mini', botInstructions: 'WA voice',
  };
  const cfg = buildAiConfig(igConfig, resolved);
  // behavior from Instagram, NOT WhatsApp
  assert.strictEqual(cfg.botInstructions, 'IG voice');
  assert.strictEqual(cfg.storeName, 'IG');
  // keys from the resolved (shared) config
  assert.strictEqual(cfg.openaiApiKey, 'sk-real');
  assert.strictEqual(cfg.anthropicApiKey, 'a');
  // instagram model wins when present
  assert.strictEqual(cfg.model, 'gpt-4o');
});

test('buildAiConfig falls back to resolved model when Instagram has none', () => {
  const cfg = buildAiConfig({ botInstructions: 'x' }, { model: 'gpt-4o', openaiApiKey: 'k' });
  assert.strictEqual(cfg.model, 'gpt-4o');
});
