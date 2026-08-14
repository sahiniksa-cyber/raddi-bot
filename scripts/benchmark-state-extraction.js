'use strict';

/**
 * Staging benchmark for the conversation-state extraction LLM call.
 *
 * Measures end-to-end latency (p50/p95/p99) and the extraction failure rate
 * (extraction_ok === false, i.e. non-JSON / schema-mismatch / timeout) against
 * a real provider, using the SAME code path the AI worker uses in production.
 *
 * It does NOT touch Postgres/Redis or send any WhatsApp message — it only
 * exercises extractConversationState() against representative, multi-vertical
 * conversation turns. Safe to run on staging.
 *
 * Usage (on staging, with provider keys in the environment):
 *   CONVERSATION_STATE_MODEL=google/gemini-2.0-flash \
 *   GOOGLE_API_KEY=... \
 *   node scripts/benchmark-state-extraction.js [iterations] [concurrency]
 *
 * Env read: GOOGLE_API_KEY|GOOGLE_AI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
 *           CONVERSATION_STATE_MODEL (optional), CONVERSATION_STATE_EXTRACT_TIMEOUT_MS.
 */

require('dotenv').config({ quiet: true });
const AIClient = require('../lib/ai-client');
const { extractConversationState } = require('../src/services/ai/conversation-state.service');

const ITERATIONS = Math.max(1, parseInt(process.argv[2] || '50', 10));
const CONCURRENCY = Math.max(1, parseInt(process.argv[3] || '4', 10));

// Representative, multi-vertical turns — no tenant-specific hardcoding, just
// realistic customer-service exchanges the extractor must generalize over.
const SCENARIOS = [
  { previousState: { open_issues: [{ id: 'i', summary: 'الطلب ما وصل', status: 'open' }] }, turn: 'خلاص وصل الطلب، شكراً', lastBot: 'رح أتابع لك الشحنة' },
  { previousState: {}, turn: 'أبغى أغيّر موعد الحجز من الخميس للسبت', lastBot: '' },
  { previousState: { open_issues: [{ id: 'i', summary: 'البرنامج ما يشتغل', status: 'open' }] }, turn: 'اشتغل بس الترخيص مو ظاهر', lastBot: 'جرّب تعيد التثبيت' },
  { previousState: {}, turn: 'ما عندي إلا محفظة كذا، تقبلونها؟', lastBot: '' },
  { previousState: {}, turn: 'السلام عليكم، كم سعر التوصيل للرياض؟', lastBot: '' },
  { previousState: { known_facts: { name: 'سعود' } }, turn: 'تمام يعطيك العافية خلاص', lastBot: 'تم تسجيل طلبك' },
];

function buildConfig() {
  const google = (process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY || '').trim();
  const openai = (process.env.OPENAI_API_KEY || '').trim();
  const openrouter = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!google && !openai && !openrouter) {
    console.error('No provider key found. Set GOOGLE_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.');
    process.exit(2);
  }
  return {
    model: (process.env.CONVERSATION_STATE_MODEL || '').trim()
      || (google ? 'google/gemini-2.0-flash' : openai ? 'gpt-4o-mini' : 'google/gemini-2.0-flash'),
    googleApiKey: google,
    openaiApiKey: openai,
    openrouterApiKey: openrouter,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const config = buildConfig();
  const silentLogger = { info() {}, warn() {}, error() {} };
  const ai = new AIClient(config, silentLogger);

  console.log(`Benchmarking conversation-state extraction`);
  console.log(`  model=${config.model}  iterations=${ITERATIONS}  concurrency=${CONCURRENCY}`);
  console.log(`  timeout=${process.env.CONVERSATION_STATE_EXTRACT_TIMEOUT_MS || 9000}ms\n`);

  const latencies = [];
  let failures = 0;
  let done = 0;

  const tasks = Array.from({ length: ITERATIONS }, (_, i) => i);
  async function runOne(i) {
    const s = SCENARIOS[i % SCENARIOS.length];
    const started = Date.now();
    let ok = false;
    try {
      const res = await extractConversationState({
        userId: 'bench', conversationId: `bench-${i}`,
        previousState: s.previousState, newTurns: [{ role: 'user', content: s.turn }],
        lastBotReply: s.lastBot, config, aiClient: ai, systemFacts: { escalationPending: false },
      });
      ok = res.extraction_ok === true;
    } catch (_) {
      ok = false;
    }
    latencies.push(Date.now() - started);
    if (!ok) failures += 1;
    done += 1;
    if (done % 10 === 0) process.stdout.write(`  ...${done}/${ITERATIONS}\n`);
  }

  // Simple concurrency pool.
  const queue = tasks.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const i = queue.shift();
      await runOne(i);
    }
  }));

  const sorted = latencies.slice().sort((a, b) => a - b);
  const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`\nResults (${latencies.length} calls):`);
  console.log(`  latency ms  p50=${percentile(sorted, 50)}  p95=${percentile(sorted, 95)}  p99=${percentile(sorted, 99)}  min=${sorted[0]}  max=${sorted[sorted.length - 1]}  mean=${mean}`);
  console.log(`  failure rate: ${((failures / latencies.length) * 100).toFixed(1)}%  (${failures}/${latencies.length} extraction_ok=false)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
