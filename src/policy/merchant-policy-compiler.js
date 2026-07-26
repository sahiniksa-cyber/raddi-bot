'use strict';

const {
  deepFreeze,
  normalizeLookupKey,
  validateMerchantPolicy,
} = require('./merchant-policy-schema');

function immutableIndex() {
  return Object.create(null);
}

function compileMerchantPolicy(input) {
  const validation = validateMerchantPolicy(input);
  if (!validation.ok) return validation;

  const productsById = immutableIndex();
  const productsByAlias = immutableIndex();
  const variantsById = immutableIndex();
  const businessRulesById = immutableIndex();
  const contactsById = immutableIndex();
  const instantRepliesById = immutableIndex();

  for (const product of validation.policy.catalog.products) {
    productsById[product.id] = product;
    productsByAlias[normalizeLookupKey(product.name)] = product;
    for (const alias of product.aliases) {
      productsByAlias[normalizeLookupKey(alias)] = product;
    }
    for (const variant of product.variants) variantsById[variant.id] = variant;
  }
  for (const rule of validation.policy.businessRules) businessRulesById[rule.id] = rule;
  for (const contact of validation.policy.routing.contacts) contactsById[contact.id] = contact;
  for (const reply of validation.policy.instantReplies) instantRepliesById[reply.id] = reply;

  const indexes = deepFreeze({
    productsById,
    productsByAlias,
    variantsById,
    businessRulesById,
    contactsById,
    instantRepliesById,
  });

  return {
    ok: true,
    policy: validation.policy,
    policyVersion: validation.policyVersion,
    indexes,
  };
}

module.exports = {
  compileMerchantPolicy,
};
