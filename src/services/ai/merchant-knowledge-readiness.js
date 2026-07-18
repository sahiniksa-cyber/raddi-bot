'use strict';

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasProductKnowledge(products) {
  if (!Array.isArray(products)) return false;
  return products.some((product) => {
    if (hasText(product)) return true;
    if (!product || typeof product !== 'object') return false;
    return [
      product.name,
      product.title,
      product.description,
      product.longDescription,
      product.price,
      product.url,
      product.link,
    ].some(value => hasText(String(value ?? '')));
  });
}

function hasApprovedReplyMap(replies) {
  if (!replies || typeof replies !== 'object' || Array.isArray(replies)) return false;
  return Object.entries(replies).some(([keyword, reply]) => {
    const replyText = reply && typeof reply === 'object'
      ? (reply.reply || reply.text || reply.answer)
      : reply;
    return hasText(keyword) && hasText(String(replyText ?? ''));
  });
}

function hasLearnedReplyKnowledge(replies) {
  if (!Array.isArray(replies)) return false;
  return replies.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const keyword = entry.keyword || entry.question || entry.trigger;
    const reply = entry.reply || entry.answer || entry.response;
    return hasText(String(keyword ?? '')) && hasText(String(reply ?? ''));
  });
}

/**
 * A model/API key, store name, tone, welcome text, or fallback text is not
 * business knowledge. At least one merchant-owned source that can ground an
 * answer must exist before AI replies are allowed.
 */
function merchantKnowledgeReadiness(config = {}) {
  const sources = [];

  if (hasText(config.storeDescription)) sources.push('store_description');
  if (hasText(config.workingHours)) sources.push('working_hours');
  if (hasText(config.botInstructions)) sources.push('bot_instructions');
  if (hasProductKnowledge(config.products)) sources.push('products');
  if (hasApprovedReplyMap(config.autoReplyKeywords)) sources.push('approved_replies');
  if (hasLearnedReplyKnowledge(config.learnedReplies)) sources.push('learned_replies');

  return {
    ready: sources.length > 0,
    sources,
    reason: sources.length > 0 ? null : 'missing_merchant_knowledge',
  };
}

function hasMerchantKnowledge(config = {}) {
  return merchantKnowledgeReadiness(config).ready;
}

module.exports = {
  hasMerchantKnowledge,
  merchantKnowledgeReadiness,
};
