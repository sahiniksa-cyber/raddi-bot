'use strict';

const { policy } = require('./send-gateway-harness');

function canonicalConfig({
  products = [],
  businessRules = [],
  contacts = [],
  routingRules = [],
  instantReplies = [],
  persona,
  operational = {},
} = {}) {
  const merchantPolicy = JSON.parse(JSON.stringify(policy().policy));
  delete merchantPolicy.policyVersion;
  merchantPolicy.catalog.products = products;
  merchantPolicy.businessRules = businessRules;
  merchantPolicy.routing.contacts = contacts;
  merchantPolicy.routing.rules = routingRules;
  merchantPolicy.instantReplies = instantReplies;
  if (persona) merchantPolicy.persona = { ...merchantPolicy.persona, ...persona };
  return { ...operational, merchantPolicy };
}

function product({
  id = 'product-1',
  name = 'Product',
  aliases = [],
  description = '',
  links = [],
  attributes = {},
  variants = [],
} = {}) {
  return {
    id,
    name,
    aliases,
    description,
    links,
    attributes,
    variants: variants.map((variant, index) => ({
      id: variant.id || `${id}-variant-${index + 1}`,
      name: variant.name || 'Standard',
      price: variant.price || null,
      duration: variant.duration || null,
      availability: variant.availability || null,
      attributes: variant.attributes || {},
    })),
  };
}

module.exports = { canonicalConfig, product };
