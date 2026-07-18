'use strict';

const AUTOMATED_CUSTOMER_REPLY_SOURCES = new Set([
  'ai_reply',
  'ai_failure_fallback',
  'auto_reply_keyword',
]);

function isAutoReplyEnabled(config = {}) {
  return config?.autoReplyEnabled !== false;
}

function isAutomatedCustomerReply(payload = {}) {
  return AUTOMATED_CUSTOMER_REPLY_SOURCES.has(payload.source)
    || payload.kind === 'quota_stop';
}

module.exports = {
  AUTOMATED_CUSTOMER_REPLY_SOURCES,
  isAutomatedCustomerReply,
  isAutoReplyEnabled,
};
