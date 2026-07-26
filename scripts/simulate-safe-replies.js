'use strict';

const { finalizeReply } = require('../src/services/ai/final-reply-pipeline');
const {
  buildProductFactCatalog,
  resolveProductFocus,
} = require('../src/services/products/product-facts');
const {
  validateCommercialClaims,
} = require('../src/services/ai/product-claim-validator');
const { stripAvoidedContent, scanForbiddenContent } = require('../lib/post-process-reply');
const { buildScopedQueueJobKey } = require('../src/queues/message-queue');

function baseConfig(overrides = {}) {
  return {
    productCatalogVersion: overrides.productCatalogVersion || 1,
    products: [
      {
        id: 'adobe',
        name: 'أدوبي',
        aliases: ['Adobe', 'ادوبى', 'ادوبي'],
        available: true,
        variants: [
          { id: 'adobe-4m', label: 'اشتراك 4 أشهر', price: 189, currency: 'SAR', available: true },
          { id: 'adobe-8m', label: 'اشتراك 8 أشهر', price: 319, currency: 'SAR', available: true },
        ],
      },
      {
        id: 'freepik',
        name: 'فري بيك',
        aliases: ['Freepik', 'فريبيك'],
        available: true,
        variants: [
          { id: 'freepik-6m', label: 'اشتراك 6 أشهر', price: 89, currency: 'SAR', available: true },
          { id: 'freepik-1y', label: 'اشتراك سنة', price: 139, currency: 'SAR', available: true },
        ],
      },
      {
        id: 'envato',
        name: 'إنفاتو',
        aliases: ['Envato', 'انفاتو'],
        available: false,
        variants: [
          { id: 'envato-1y', label: 'اشتراك سنة', price: 499, currency: 'SAR', available: false },
        ],
      },
    ],
    replyStyle: {
      replyLength: 'short',
      maxResponseLength: 180,
      maxSentences: 2,
      maxLines: 2,
      avoidWords: ['ممنوع-خاص'],
      avoidPhrases: ['إذا تحتاج شي ثاني انا موجود'],
      employeeNameEnabled: false,
      employeeName: 'محمد',
    },
    ...overrides,
  };
}

function scenarioDefinitions() {
  return [
    { id: 'adobe-4-correct', customer: 'كم أدوبي 4 أشهر؟', draft: 'أدوبي 4 أشهر بـ189 ريال.', expect: /189/ },
    { id: 'adobe-8-correct', customer: 'أبي اشتراك أدوبي ثمانية أشهر', draft: 'أدوبي 8 أشهر بـ319 ريال.', expect: /319/ },
    { id: 'reject-cross-freepik-6', customer: 'كم أدوبي 6 أشهر؟', draft: 'أدوبي 6 أشهر بـ89 ريال.', rejectOriginal: true, expect: /غير متوفر/ },
    { id: 'reject-cross-freepik-year', customer: 'كم سنة أدوبي؟', draft: 'أدوبي سنة بـ139 ريال.', rejectOriginal: true, expect: /غير متوفر/ },
    { id: 'reject-stale-price', customer: 'كم أدوبي 8 أشهر؟', draft: 'أدوبي 8 أشهر بـ289 ريال.', rejectOriginal: true, expect: /319/ },
    { id: 'unavailable-product', customer: 'كم إنفاتو سنة؟', draft: 'إنفاتو سنة بـ499 ريال ومتوفر.', rejectOriginal: true, expect: /غير متوفر/ },
    { id: 'ambiguous-year', customer: 'كم السنة؟', draft: 'السنة بـ139 ريال.', rejectOriginal: true, expect: /أي منتج|حدد/ },
    {
      id: 'context-adobe-no-year',
      customer: 'كم السنة؟',
      history: [{ role: 'user', content: 'أبي أدوبي' }, { role: 'assistant', content: 'أي مدة؟' }],
      draft: 'أدوبي سنة بـ139 ريال.',
      rejectOriginal: true,
      expect: /غير متوفر/,
    },
    { id: 'freepik-6', customer: 'كم فري بيك 6 أشهر؟', draft: 'فري بيك 6 أشهر بـ89 ريال.', expect: /89/ },
    { id: 'freepik-year', customer: 'كم فريبيك سنة؟', draft: 'فري بيك سنة بـ139 ريال.', expect: /139/ },
    { id: 'typo-alias', customer: 'كم ادوبى ٤ أشهر؟', draft: 'أدوبي 4 أشهر بـ189 ريال.', expect: /189/ },
    { id: 'english', customer: 'Adobe 4 months price?', draft: 'Adobe 4 months is 189 SAR.', expect: /189/ },
    { id: 'mixed-language', customer: 'Adobe ثمانية أشهر كم؟', draft: 'أدوبي 8 أشهر بـ319 SAR.', expect: /319/ },
    { id: 'two-products-ambiguous', customer: 'قارن أدوبي وفري بيك بالسنة', draft: 'السنة بـ139 ريال.', rejectOriginal: true, expect: /أي منتج|حدد/ },
    {
      id: 'switch-product',
      customer: 'لا قصدي فري بيك 6 أشهر',
      history: [{ role: 'user', content: 'كم أدوبي؟' }, { role: 'assistant', content: 'أي مدة؟' }],
      draft: 'فري بيك 6 أشهر بـ89 ريال.',
      expect: /89/,
    },
    {
      id: 'duration-only-clear-context',
      customer: '8 أشهر',
      history: [{ role: 'user', content: 'أبي أدوبي' }, { role: 'assistant', content: 'أي مدة؟' }],
      draft: 'أدوبي 8 أشهر بـ319 ريال.',
      expect: /319/,
    },
    {
      id: 'confirm-number',
      customer: 'يعني أدوبي 189 صح؟',
      draft: 'نعم، أدوبي 4 أشهر بـ189 ريال.',
      expect: /189/,
    },
    {
      id: 'forbidden-and-name',
      customer: 'عرفني بالسعر',
      draft: 'أنا محمد، أدوبي 4 أشهر بـ189 ريال. إذا تحتاج شي ثاني انا موجود',
      expect: /189/,
      forbidden: /محمد|إذا تحتاج شي ثاني/,
    },
    {
      id: 'automation-disclosure',
      customer: 'أنت مين؟',
      draft: 'أنا روبوت AI. أدوبي 4 أشهر بـ189 ريال.',
      expect: /189/,
      forbidden: /روبوت|\bAI\b/i,
    },
    {
      id: 'price-version-before-change',
      customer: 'كم أدوبي 4 أشهر؟',
      draft: 'أدوبي 4 أشهر بـ189 ريال.',
      expect: /189/,
      expectedCatalogVersion: 1,
    },
  ];
}

function runOneScenario(definition, config = baseConfig()) {
  const history = [...(definition.history || []), { role: 'user', content: definition.customer }];
  const catalog = buildProductFactCatalog(config, { catalogVersion: config.productCatalogVersion });
  const focus = resolveProductFocus({ catalog, history, customerText: definition.customer });
  const initial = validateCommercialClaims(definition.draft, { catalog, focus });
  const sanitized = stripAvoidedContent(definition.draft, config);
  const result = finalizeReply({
    draft: sanitized,
    history,
    customerText: definition.customer,
    config,
  });
  const finalValidation = result.reply
    ? validateCommercialClaims(result.reply, { catalog, focus })
    : { valid: false, issues: [] };
  const forbidden = scanForbiddenContent(result.reply, config);
  const failures = [];
  if (result.decision !== 'validated') failures.push(`decision=${result.decision}`);
  if (!finalValidation.valid) failures.push('final_commercial_claim_invalid');
  if (forbidden.blocked) failures.push(`forbidden:${forbidden.matches.join(',')}`);
  if (definition.rejectOriginal && initial.valid) failures.push('unsafe_original_was_not_rejected');
  if (definition.expect && !definition.expect.test(result.reply)) failures.push('expected_answer_missing');
  if (definition.forbidden && definition.forbidden.test(result.reply)) failures.push('forbidden_text_survived');
  if (
    definition.expectedCatalogVersion != null
    && result.audit.catalogVersion !== definition.expectedCatalogVersion
  ) failures.push('catalog_version_mismatch');
  return {
    id: definition.id,
    sent: result.decision === 'validated',
    blockedOriginal: !initial.valid,
    reason: result.reason,
    original: definition.draft,
    final: result.reply,
    catalogVersion: result.audit.catalogVersion,
    failures,
  };
}

async function runSimulation() {
  const results = scenarioDefinitions().map(definition => runOneScenario(definition));

  // Same product, different prices in twenty stores, evaluated concurrently.
  const tenantResults = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const price = 500 + index;
    const config = baseConfig({
      productCatalogVersion: 100 + index,
      products: [{
        id: 'shared-product',
        name: 'منتج مشترك',
        aliases: ['Shared'],
        variants: [{ id: 'shared-4m', label: '4 أشهر', price, currency: 'SAR', available: true }],
      }],
    });
    await new Promise(resolve => setImmediate(resolve));
    const result = runOneScenario({
      id: `tenant-price-${index}`,
      customer: 'كم منتج مشترك 4 أشهر؟',
      draft: `منتج مشترك 4 أشهر بـ${price} ريال.`,
      expect: new RegExp(`\\b${price}\\b`),
      expectedCatalogVersion: 100 + index,
    }, config);
    const key = buildScopedQueueJobKey('ai', {
      userId: `tenant-${index}`,
      tenantId: `tenant-${index}`,
      channelId: 'whatsapp',
      conversationId: `conversation-${index}`,
      customerId: `customer-${index}`,
    }, 'provider-same');
    return { ...result, queueKey: key };
  }));
  results.push(...tenantResults);

  const uniqueKeys = new Set(tenantResults.map(result => result.queueKey));
  if (uniqueKeys.size !== tenantResults.length) {
    results.push({
      id: 'queue-key-isolation',
      sent: false,
      blockedOriginal: false,
      reason: 'queue_key_collision',
      original: '',
      final: '',
      failures: ['queue_key_collision'],
    });
  }

  // Price changes during a live conversation: old and new replies retain their
  // own immutable catalog version and each validates only against its snapshot.
  const changedConfig = baseConfig({
    productCatalogVersion: 2,
    products: baseConfig().products.map(product => (
      product.id === 'adobe'
        ? {
          ...product,
          variants: product.variants.map(plan => (
            plan.id === 'adobe-4m' ? { ...plan, price: 199 } : plan
          )),
        }
        : product
    )),
  });
  results.push(runOneScenario({
    id: 'price-version-after-change',
    customer: 'كم أدوبي 4 أشهر؟',
    draft: 'أدوبي 4 أشهر بـ199 ريال.',
    expect: /199/,
    expectedCatalogVersion: 2,
  }, changedConfig));

  const failures = results.flatMap(result => result.failures.map(reason => ({ id: result.id, reason })));
  const sent = results.filter(result => result.sent).length;
  const blockedOriginal = results.filter(result => result.blockedOriginal).length;
  return {
    mode: 'shadow_no_send',
    scenarios: results.length,
    repliesSentToWhatsapp: 0,
    validatedReplies: sent,
    blockedOriginalDrafts: blockedOriginal,
    blockReasons: Object.fromEntries(
      [...new Set(results.filter(result => result.blockedOriginal).map(result => result.reason))]
        .map(reason => [reason, results.filter(result => result.blockedOriginal && result.reason === reason).length]),
    ),
    failures,
    exactAccuracy: results.length ? (results.length - failures.length) / results.length : 0,
    examples: results.slice(0, 8).map(({ id, original, final, reason }) => ({ id, original, final, reason })),
    results,
  };
}

if (require.main === module) {
  runSimulation()
    .then(summary => {
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = summary.failures.length ? 1 : 0;
    })
    .catch(error => {
      console.error(JSON.stringify({ mode: 'shadow_no_send', fatal: error.message }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  baseConfig,
  runOneScenario,
  runSimulation,
  scenarioDefinitions,
};
