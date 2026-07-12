'use strict';

/**
 * Instagram sandbox reply generator — powers the dashboard "جرّب البوت" box for
 * Instagram. Produces an AI reply using the merchant's INSTAGRAM config + keys,
 * exactly like instagram-worker's processIncoming, but as a pure dry-run:
 *   - no DB writes, no send, no quota decrement
 * so the merchant can test their Instagram brain before (or instead of) a real DM.
 *
 * Mirrors buildAiConfig from src/workers/instagram-worker.js.
 */

const AIClient = require('../../../lib/ai-client');
const { resolveInstagramConfig } = require('./instagram-config');
const { resolveConfigForAI } = require('../bot/runtime-bot');

function buildAiConfig(igConfig, resolved) {
  return {
    ...igConfig,
    openaiApiKey: resolved.openaiApiKey,
    openrouterApiKey: resolved.openrouterApiKey,
    googleApiKey: resolved.googleApiKey,
    anthropicApiKey: resolved.anthropicApiKey,
    model: igConfig.model || resolved.model,
  };
}

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

// history: [{ role: 'user'|'assistant', content }] — the running sandbox thread.
async function generateInstagramTestReply(userId, history, deps = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('userId required');
  const resolveCfg = deps.resolveInstagramConfig || resolveInstagramConfig;
  const resolveKeys = deps.resolveConfigForAI || resolveConfigForAI;
  const AI = deps.AIClient || AIClient;

  const igSettings = await resolveCfg(uid, { database: deps.database });
  const resolved = await resolveKeys(uid);
  const config = buildAiConfig(igSettings.config || {}, resolved || {});
  const ai = new AI(config, deps.logger || NOOP_LOGGER, { record: async () => {} });

  const isFirstMsg = (history || []).filter((m) => m.role === 'assistant').length === 0;
  const reply = String((await ai.getReply(history || [], { isFirstMsg })) || '').trim();
  return { reply, model: config.model, aiEnabled: igSettings.enabled === true };
}

module.exports = { generateInstagramTestReply, buildAiConfig };
