'use strict';

const {
  buildProductCatalog,
  findRelevantProducts,
  normalizeProductText,
} = require('../products/product-knowledge');

const SIGNAL_STATES = Object.freeze({
  interested: 'interested_unverified',
  ordered: 'ordered_confirmed',
  verify: 'needs_verification',
});

const STATE_PRIORITY = Object.freeze({
  interested_unverified: 1,
  needs_verification: 2,
  ordered_confirmed: 3,
});

// Deliberately requires a concrete reference before a conversation-only signal
// can be called "ordered_confirmed". A model/customer saying "I ordered" is a
// useful lead, but not proof of an order in the merchant's system.
const ORDER_REFERENCE_RE = /(?:طلب|اوردر|order)\s*(?:رقم|number|no\.?|num)?\s*[#:]?\s*([A-Z0-9][A-Z0-9-]{3,19})\b/i;
const ORDER_CLAIM_RE = /(?:^|\s)(?:طلبت|اشتريت|شريت|تم\s+الطلب|سويت\s+طلب|دفعت|تم\s+الدفع|حولت|أتممت\s+الشراء|اكملت\s+الطلب)(?:\s|$)/i;
const NEGATIVE_ORDER_RE = /(?:ما|لم|لسه\s+ما|للحين\s+ما|ماني)\s*(?:طلبت|اشتريت|شريت|دفعت|سويت\s+طلب)/i;
const INTEREST_RE = /(?:كم|سعر|متوفر|موجود|أبي|ابي|ابغى|أبغى|ودي|احتاج|أحتاج|تفاصيل|مواصفات|رابط|عرض|خصم|اشتراك|مدة)/i;

function clampConfidence(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => String(message?.content || message?.body || '').trim())
    .map(message => ({
      id: message.id || message.messageId || null,
      role: message.role || (message.direction === 'inbound' ? 'user' : 'assistant'),
      direction: message.direction || (message.role === 'user' ? 'inbound' : 'outbound'),
      content: String(message.content || message.body || '').trim(),
      createdAt: message.created_at || message.createdAt || null,
    }))
    .filter(message => message.direction === 'inbound' || message.role === 'user');
}

function detectOrderEvidence(text) {
  const clean = String(text || '').trim();
  const reference = clean.match(ORDER_REFERENCE_RE)?.[1] || '';
  if (reference) {
    return {
      state: SIGNAL_STATES.ordered,
      confidence: 0.99,
      orderReference: reference,
      reason: 'order_reference',
    };
  }
  if (NEGATIVE_ORDER_RE.test(clean)) {
    return {
      state: SIGNAL_STATES.interested,
      confidence: 0.94,
      orderReference: '',
      reason: 'explicit_not_ordered',
    };
  }
  if (ORDER_CLAIM_RE.test(clean)) {
    return {
      state: SIGNAL_STATES.verify,
      confidence: 0.72,
      orderReference: '',
      reason: 'order_claim_without_reference',
    };
  }
  return {
    state: SIGNAL_STATES.interested,
    confidence: INTEREST_RE.test(clean) ? 0.84 : 0.7,
    orderReference: '',
    reason: 'product_interest',
  };
}

function strongerSignal(current, candidate) {
  if (!current) return candidate;
  const currentPriority = STATE_PRIORITY[current.state] || 0;
  const candidatePriority = STATE_PRIORITY[candidate.state] || 0;
  if (candidatePriority > currentPriority) return candidate;
  if (candidatePriority < currentPriority) return current;
  return candidate.confidence >= current.confidence ? candidate : current;
}

function classifyConversationDeterministic({ messages = [], config = {} } = {}) {
  const inbound = normalizeMessages(messages);
  if (!inbound.length) return [];
  const catalog = buildProductCatalog(config);
  if (!catalog.length) return [];

  const byProduct = new Map();
  let recentProducts = [];
  for (const message of inbound) {
    const relevant = findRelevantProducts(config, message.content, 4);
    if (relevant.length) recentProducts = relevant.slice(0, 2);
    const order = detectOrderEvidence(message.content);
    // Customers often mention the product first, then send a short follow-up
    // such as "تم الطلب، رقم الطلب AB-1234". Associate that evidence with the
    // most recently mentioned product instead of leaving the old interest row
    // stale forever.
    const hasStandaloneOrderUpdate = relevant.length === 0
      && ['order_reference', 'order_claim_without_reference', 'explicit_not_ordered'].includes(order.reason);
    const productsForMessage = relevant.length ? relevant : (hasStandaloneOrderUpdate ? recentProducts : []);
    for (const product of productsForMessage) {
      const productKey = normalizeProductText(product.name);
      if (!productKey) continue;
      const candidate = {
        productKey,
        productName: product.name,
        state: order.state,
        confidence: order.confidence,
        orderReference: order.orderReference || null,
        evidenceMessageId: message.id || null,
        evidenceText: message.content.slice(0, 500),
        detectedAt: message.createdAt || null,
        source: 'conversation_rules',
        metadata: { reason: order.reason },
      };
      byProduct.set(productKey, strongerSignal(byProduct.get(productKey), candidate));
    }
  }
  return [...byProduct.values()];
}

function validateAiSignals({ signals = [], config = {}, messages = [] } = {}) {
  const catalog = buildProductCatalog(config);
  const catalogByKey = new Map(catalog.map(product => [normalizeProductText(product.name), product]));
  const inbound = normalizeMessages(messages);
  const validated = [];

  for (const raw of Array.isArray(signals) ? signals : []) {
    const key = normalizeProductText(raw?.productName || raw?.product || '');
    const product = catalogByKey.get(key);
    if (!product) continue;
    let state = Object.values(SIGNAL_STATES).includes(raw?.state)
      ? raw.state
      : SIGNAL_STATES.interested;
    let evidence = String(raw?.evidenceText || '').trim().slice(0, 500);
    const sourceMessage = inbound.find(message => evidence && message.content.includes(evidence))
      || inbound.find(message => normalizeProductText(message.content).includes(key))
      || inbound[inbound.length - 1];
    if (!evidence && sourceMessage) evidence = sourceMessage.content.slice(0, 500);
    const concreteReference = evidence.match(ORDER_REFERENCE_RE)?.[1]
      || String(raw?.orderReference || '').match(/^[A-Z0-9][A-Z0-9-]{3,19}$/i)?.[0]
      || '';

    // The AI is allowed to flag a likely order, never to manufacture proof.
    if (state === SIGNAL_STATES.ordered && !concreteReference) {
      state = SIGNAL_STATES.verify;
    }
    validated.push({
      productKey: key,
      productName: product.name,
      state,
      confidence: clampConfidence(raw?.confidence, state === SIGNAL_STATES.verify ? 0.65 : 0.75),
      orderReference: concreteReference || null,
      evidenceMessageId: sourceMessage?.id || null,
      evidenceText: evidence,
      detectedAt: sourceMessage?.createdAt || null,
      source: 'conversation_ai',
      metadata: { aiReviewed: true },
    });
  }
  return validated;
}

function mergeSignals(...signalLists) {
  const merged = new Map();
  for (const signal of signalLists.flat()) {
    if (!signal?.productKey) continue;
    merged.set(signal.productKey, strongerSignal(merged.get(signal.productKey), signal));
  }
  return [...merged.values()];
}

async function upsertSignals({ database, userId, conversationId = null, sender, signals = [] } = {}) {
  if (!database || typeof database.query !== 'function') throw new Error('database is required');
  if (!userId || !sender) throw new Error('userId and sender are required');
  const saved = [];
  for (const signal of signals) {
    const result = await database.query(
      `INSERT INTO customer_product_signals (
         user_id, conversation_id, sender, product_key, product_name, state,
         confidence, evidence_message_id, evidence_text, order_reference,
         source, first_detected_at, last_detected_at, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         COALESCE($12::timestamptz, NOW()), COALESCE($12::timestamptz, NOW()), $13::jsonb
       )
       ON CONFLICT (user_id, sender, product_key) DO UPDATE SET
         conversation_id = COALESCE(EXCLUDED.conversation_id, customer_product_signals.conversation_id),
         product_name = EXCLUDED.product_name,
         state = CASE
           WHEN customer_product_signals.state = 'ordered_confirmed' THEN customer_product_signals.state
           WHEN EXCLUDED.state = 'ordered_confirmed' THEN EXCLUDED.state
           WHEN customer_product_signals.state = 'needs_verification' AND EXCLUDED.state = 'interested_unverified'
             THEN customer_product_signals.state
           ELSE EXCLUDED.state
         END,
         confidence = GREATEST(customer_product_signals.confidence, EXCLUDED.confidence),
         evidence_message_id = COALESCE(EXCLUDED.evidence_message_id, customer_product_signals.evidence_message_id),
         evidence_text = CASE WHEN EXCLUDED.evidence_text <> '' THEN EXCLUDED.evidence_text ELSE customer_product_signals.evidence_text END,
         order_reference = COALESCE(EXCLUDED.order_reference, customer_product_signals.order_reference),
         source = EXCLUDED.source,
         last_detected_at = GREATEST(customer_product_signals.last_detected_at, EXCLUDED.last_detected_at),
         metadata = customer_product_signals.metadata || EXCLUDED.metadata
       RETURNING *`,
      [
        userId,
        conversationId,
        sender,
        signal.productKey,
        signal.productName,
        signal.state,
        clampConfidence(signal.confidence),
        signal.evidenceMessageId || null,
        String(signal.evidenceText || '').slice(0, 500),
        signal.orderReference || null,
        signal.source || 'conversation',
        signal.detectedAt || null,
        JSON.stringify(signal.metadata || {}),
      ],
    );
    if (result.rows[0]) saved.push(result.rows[0]);
  }
  return saved;
}

module.exports = {
  INTEREST_RE,
  NEGATIVE_ORDER_RE,
  ORDER_CLAIM_RE,
  ORDER_REFERENCE_RE,
  SIGNAL_STATES,
  classifyConversationDeterministic,
  clampConfidence,
  detectOrderEvidence,
  mergeSignals,
  normalizeMessages,
  strongerSignal,
  upsertSignals,
  validateAiSignals,
};
