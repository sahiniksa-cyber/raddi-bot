'use strict';

const {
  authenticatePolicyContext,
  validateAutomatedReply,
} = require('./deterministic-reply-validator');

const FALLBACK_TEMPLATES = Object.freeze({
  clarify: () => 'فضلاً وضّح طلبك لأفهم المقصود.',
  contact: contact => `للتواصل: ${contact.phoneNumber}`,
  product: product => `هل تقصد ${product.name}؟`,
});

function normalizedFocus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      evidenceRefs: [],
      productId: null,
      topics: [],
      variantId: null,
    };
  }
  return {
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? [...new Set(value.evidenceRefs.filter(ref => typeof ref === 'string'))]
      : [],
    productId: typeof value.productId === 'string' ? value.productId : null,
    topics: Array.isArray(value.topics) ? value.topics.slice() : [],
    variantId: typeof value.variantId === 'string' ? value.variantId : null,
  };
}

function candidateForReference({ compiledPolicy, evidenceRef, focus }) {
  if (!evidenceRef
      || !focus.evidenceRefs.includes(evidenceRef)
      || compiledPolicy?.ok !== true
      || !compiledPolicy.indexes) {
    return null;
  }

  const contact = compiledPolicy.indexes.contactsById[evidenceRef];
  if (contact) {
    return {
      evidenceRefs: [evidenceRef],
      reply: FALLBACK_TEMPLATES.contact(contact),
      templateId: 'contact',
    };
  }

  const product = compiledPolicy.indexes.productsById[evidenceRef];
  if (product && focus.productId === product.id) {
    return {
      evidenceRefs: [evidenceRef],
      reply: FALLBACK_TEMPLATES.product(product),
      templateId: 'product',
    };
  }
  return null;
}

function validateCandidate({
  customerText,
  focus,
  reply,
  compiledPolicy,
  platformPolicy,
}) {
  return validateAutomatedReply({
    customerText,
    conversationFocus: focus,
    reply,
    compiledPolicy,
    platformPolicy,
  });
}

function safeClarification({
  customerText,
  focus,
  compiledPolicy,
  platformPolicy,
}) {
  const safeFocus = {
    ...focus,
    evidenceRefs: [],
    productId: null,
    variantId: null,
  };
  const reply = FALLBACK_TEMPLATES.clarify();
  return {
    evidenceRefs: [],
    reply,
    templateId: 'clarify',
    validation: validateCandidate({
      customerText,
      focus: safeFocus,
      reply,
      compiledPolicy,
      platformPolicy,
    }),
  };
}

function buildDeterministicFallback({
  customerText = '',
  conversationFocus = {},
  compiledPolicy,
  platformPolicy,
  evidenceRef = null,
} = {}) {
  const focus = normalizedFocus(conversationFocus);
  const authenticated = authenticatePolicyContext(compiledPolicy, platformPolicy);
  if (!authenticated.ok) {
    return safeClarification({
      customerText,
      focus,
      compiledPolicy,
      platformPolicy,
    });
  }
  compiledPolicy = authenticated.compiledPolicy;
  platformPolicy = authenticated.platformPolicy;
  const candidate = candidateForReference({
    compiledPolicy,
    evidenceRef,
    focus,
  });
  if (!candidate) {
    return safeClarification({
      customerText,
      focus,
      compiledPolicy,
      platformPolicy,
    });
  }

  const validation = validateCandidate({
    customerText,
    focus,
    reply: candidate.reply,
    compiledPolicy,
    platformPolicy,
  });
  if (!validation.ok) {
    return safeClarification({
      customerText,
      focus,
      compiledPolicy,
      platformPolicy,
    });
  }
  return {
    ...candidate,
    validation,
  };
}

module.exports = {
  buildDeterministicFallback,
};
