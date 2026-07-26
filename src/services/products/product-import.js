'use strict';

const { compileMerchantPolicy } = require('../../policy/merchant-policy-compiler');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeImportedProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return null;
  if (typeof product.id !== 'string' || !product.id.trim()) return null;
  if (typeof product.name !== 'string' || !product.name.trim()) return null;
  if (!Array.isArray(product.aliases)
      || !Array.isArray(product.variants)
      || !Array.isArray(product.links)
      || !product.attributes
      || typeof product.attributes !== 'object'
      || Array.isArray(product.attributes)) {
    return null;
  }
  return clone(product);
}

function mergeImportedProducts(existingProducts = [], importedProducts = []) {
  const byId = new Map();
  for (const entry of existingProducts) {
    const product = normalizeImportedProduct(entry);
    if (product) byId.set(product.id, product);
  }
  for (const entry of importedProducts) {
    const product = normalizeImportedProduct(entry);
    if (product) byId.set(product.id, product);
  }
  return [...byId.values()];
}

function organizeProductsForConfig(config = {}, importedProducts = []) {
  const current = compileMerchantPolicy(config.merchantPolicy);
  if (!current.ok || current.policy.status !== 'active') {
    const error = new Error('Active merchantPolicy is required before product import');
    error.code = 'POLICY_INVALID';
    throw error;
  }

  const policy = clone(current.policy);
  delete policy.policyVersion;
  const accepted = [];
  const reviewItems = [];
  const imported = Array.isArray(importedProducts) ? importedProducts : [];
  imported.forEach((entry, index) => {
    const normalized = normalizeImportedProduct(entry);
    const validationCandidate = normalized
      ? {
          ...clone(current.policy),
          policyVersion: undefined,
          catalog: { products: [normalized] },
        }
      : null;
    if (validationCandidate) delete validationCandidate.policyVersion;
    const validation = validationCandidate
      ? compileMerchantPolicy(validationCandidate)
      : { ok: false };
    if (normalized && validation.ok) {
      accepted.push(normalized);
    } else {
      reviewItems.push({
        path: `productImport[${index}]`,
        code: 'untyped_or_invalid_product',
      });
    }
  });
  policy.catalog.products = mergeImportedProducts(policy.catalog.products, accepted);
  if (reviewItems.length) {
    policy.status = 'needs_review';
    policy.migration.reviewItems = [
      ...(policy.migration.reviewItems || []),
      ...reviewItems,
    ];
  }
  const compiled = compileMerchantPolicy(policy);
  if (!compiled.ok) {
    const error = new Error('Imported canonical products failed policy validation');
    error.code = 'INVALID_MERCHANT_POLICY';
    error.details = compiled.errors;
    throw error;
  }
  return {
    ...config,
    merchantPolicy: compiled.policy,
    productImportReport: {
      accepted: accepted.map(product => product.id),
      reviewItems,
    },
  };
}

module.exports = {
  mergeImportedProducts,
  normalizeImportedProduct,
  organizeProductsForConfig,
};
