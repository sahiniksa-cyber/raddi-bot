'use strict';

require('dotenv').config({ quiet: true });

const db = require('../src/db/client');
const AIClient = require('../lib/ai-client');
const { resolveConfigForAI } = require('../src/services/bot/runtime-bot');
const { applyLineBreakFormat } = require('../lib/post-process-reply');
const { similarity } = require('../src/workers/reply-deduplication');

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function clampLimit(value) {
  const parsed = parseInt(value, 10);
  return Math.min(30, Math.max(1, Number.isFinite(parsed) ? parsed : 10));
}

async function resolveReplayUserId(explicitUserId) {
  if (explicitUserId) return explicitUserId;
  const result = await db.query(
    `SELECT ws.user_id
       FROM whatsapp_sessions ws
      WHERE ws.status = 'connected'
      ORDER BY (
        SELECT MAX(m.created_at) FROM messages m WHERE m.user_id = ws.user_id
      ) DESC NULLS LAST
      LIMIT 1`,
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) throw new Error('No connected merchant with conversation history was found');
  return userId;
}

async function loadRealConversationSamples(userId, limit) {
  const replies = await db.query(
    `SELECT id, conversation_id, content, created_at,
            COALESCE(raw_payload->>'source', 'unknown') AS source
       FROM messages
      WHERE user_id = $1
        AND direction = 'outbound'
        AND role = 'assistant'
        AND status = 'sent'
        AND LENGTH(TRIM(content)) > 1
        AND COALESCE(raw_payload->>'source', '') <> 'manual_send'
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.min(150, limit * 5)],
  );

  const samples = [];
  for (const reply of replies.rows) {
    const previous = await db.query(
      `SELECT role, direction, content, created_at
         FROM messages
        WHERE user_id = $1
          AND conversation_id = $2
          AND created_at < $3
          AND LENGTH(TRIM(content)) > 0
        ORDER BY created_at DESC
        LIMIT 12`,
      [userId, reply.conversation_id, reply.created_at],
    );
    const history = previous.rows.slice().reverse().map(message => ({
      role: message.role === 'assistant' || message.direction === 'outbound' ? 'assistant' : 'user',
      content: String(message.content || '').trim(),
    }));
    const customerText = [...history].reverse().find(message => message.role === 'user')?.content || '';
    if (!customerText) continue;
    samples.push({
      id: String(reply.id),
      conversationId: String(reply.conversation_id),
      source: reply.source || 'historical_ai_reply',
      customerText,
      history,
      draft: String(reply.content || '').trim(),
      kind: 'real_conversation',
    });
    if (samples.length >= limit) break;
  }
  return samples;
}

function reportedScenarios() {
  return [
    {
      id: 'reported-semantic-repeat',
      conversationId: 'reported-example',
      source: 'ai_reply',
      customerText: 'باخذ ادوبي وباخذ فريبيك',
      history: [
        { role: 'user', content: 'وانت عارف دايما اخذ من عندكم' },
        { role: 'assistant', content: 'والله آسف لو صار سوء فهم بخصوص الكود السابق، حالياً ما عندنا كود خصم شغال، لكن عشانك عميل دائم نقدر نوفر لك خيار تقسيط مع تمارا.' },
      ],
      draft: 'والله يا غالي، حالياً ما عندنا كود خصم شغال، لكن تقدر تستفيد من تقسيط تمارا لو حاب بالنسبة لاشتراك أدوبي وفريبيك، تقدر تطلبهم من المتجر مباشرة. إذا حاب تدفع بالتقسيط، أعطيني رقم جوالك عشان أرسل طلب الدفع.',
      kind: 'reported_screenshot',
    },
    {
      id: 'reported-instant-greeting',
      conversationId: 'reported-example',
      source: 'auto_reply_keyword',
      customerText: 'السلام عليكم',
      history: [{ role: 'user', content: 'السلام عليكم' }],
      draft: 'وعليكم السلام، هلا ومرحبا\nورحمة الله وبركاته',
      kind: 'reported_screenshot',
    },
  ];
}

function lineFormatScenario() {
  return {
    id: 'line-format-acceptance',
    conversationId: 'acceptance-example',
    source: 'ai_reply',
    customerText: 'وضح لي الخطوات باختصار',
    history: [{ role: 'user', content: 'وضح لي الخطوات باختصار' }],
    draft: 'أهلاً بك. فهمت طلبك. سأشرح لك الخطوات باختصار.',
    kind: 'line_format_acceptance',
  };
}

function maximumPreviousAssistantSimilarity(reply, history) {
  return history
    .filter(message => message.role === 'assistant')
    .reduce((max, message) => Math.max(max, similarity(reply, message.content)), 0);
}

async function reviewSample(ai, config, sample) {
  const startedAt = Date.now();
  const result = await ai.reviewBeforeSend({
    draft: sample.draft,
    history: sample.history,
    customerText: sample.customerText,
    source: sample.source,
  });
  const reply = String(result.reply || '').trim();
  const expectedLines = result.suppressed ? '' : applyLineBreakFormat(reply, config);
  return {
    id: sample.id,
    conversationId: sample.conversationId,
    kind: sample.kind,
    source: sample.source,
    customerText: sample.customerText,
    before: sample.draft,
    decision: result.audit?.decision || (result.suppressed ? 'suppress' : 'unknown'),
    reason: result.audit?.reason || '',
    repeatedClaims: result.audit?.repeatedClaims || [],
    violations: result.audit?.violations || [],
    after: reply,
    suppressed: result.suppressed === true,
    lineFormatApplied: result.suppressed === true || reply === expectedLines,
    lineCount: result.suppressed ? 0 : reply.split(/\r?\n/).length,
    maxPreviousAssistantSimilarity: result.suppressed ? 0 : Number(maximumPreviousAssistantSimilarity(reply, sample.history).toFixed(3)),
    latencyMs: Date.now() - startedAt,
  };
}

async function main() {
  if (!db.isConfigured()) throw new Error('DATABASE_URL is required');
  const limit = clampLimit(argValue('--limit', '10'));
  const userId = await resolveReplayUserId(argValue('--user'));
  const config = await resolveConfigForAI(userId);
  const keyUserId = argValue('--key-user').trim();
  if (keyUserId && keyUserId !== userId) {
    const keyConfig = await resolveConfigForAI(keyUserId);
    for (const key of ['openaiApiKey', 'googleApiKey', 'openrouterApiKey', 'anthropicApiKey']) {
      if (String(keyConfig?.[key] || '').trim()) config[key] = keyConfig[key];
    }
  }
  const lineModeOverride = argValue('--line-mode').trim();
  if (lineModeOverride) {
    config.replyStyle = { ...(config.replyStyle || {}), lineBreakMode: lineModeOverride };
  }
  const logger = { info() {}, warn(stage, message) { process.stderr.write(`[${stage}] ${message}\n`); }, error() {} };
  const ai = new AIClient(config, logger, { record() {} });
  const realSamples = await loadRealConversationSamples(userId, limit);
  if (!realSamples.length) throw new Error('No usable real conversation samples were found');

  const results = [];
  for (const sample of [...reportedScenarios(), lineFormatScenario(), ...realSamples]) {
    try {
      results.push(await reviewSample(ai, config, sample));
    } catch (error) {
      results.push({
        id: sample.id,
        conversationId: sample.conversationId,
        kind: sample.kind,
        source: sample.source,
        before: sample.draft,
        error: String(error?.message || error),
      });
    }
  }

  const acceptanceFailures = new Map();
  const reportedRepeat = results.find(result => result.id === 'reported-semantic-repeat');
  if (!reportedRepeat || reportedRepeat.error || reportedRepeat.suppressed !== true) {
    acceptanceFailures.set('reported-semantic-repeat', 'semantic repeat was not suppressed');
  }
  const reportedGreeting = results.find(result => result.id === 'reported-instant-greeting');
  if (!reportedGreeting || reportedGreeting.error || reportedGreeting.suppressed === true
      || /ورحمة الله وبركاته/.test(reportedGreeting.after || '') || reportedGreeting.lineCount !== 1) {
    acceptanceFailures.set('reported-instant-greeting', 'instant greeting was silenced or remained duplicated');
  }
  const lineAcceptance = results.find(result => result.id === 'line-format-acceptance');
  if (!lineAcceptance || lineAcceptance.error || lineAcceptance.suppressed === true
      || (config?.replyStyle?.lineBreakMode !== 'connected' && lineAcceptance.lineCount < 2)) {
    acceptanceFailures.set('line-format-acceptance', 'selected line-break mode was not visibly enforced');
  }
  for (const result of results) {
    result.acceptanceError = acceptanceFailures.get(result.id) || null;
  }
  const failed = results.filter(result => result.error || result.lineFormatApplied === false || result.acceptanceError);
  const summary = {
    userId,
    noWhatsappSend: true,
    noDatabaseWrites: true,
    requestedRealSamples: limit,
    reviewedRealSamples: results.filter(result => result.kind === 'real_conversation').length,
    reviewedReportedSamples: results.filter(result => result.kind === 'reported_screenshot').length,
    reviewedLineFormatSamples: results.filter(result => result.kind === 'line_format_acceptance').length,
    lineBreakMode: config?.replyStyle?.lineBreakMode || 'connected',
    decisions: results.reduce((counts, result) => {
      const key = result.error ? 'error' : result.decision;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    failed: failed.length,
  };
  process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => db.close().catch(() => {}));
}

module.exports = {
  clampLimit,
  loadRealConversationSamples,
  lineFormatScenario,
  maximumPreviousAssistantSimilarity,
  reportedScenarios,
  reviewSample,
};
