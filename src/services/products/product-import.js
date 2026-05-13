'use strict';

const { buildProductCatalog, normalizeProductText } = require('./product-knowledge');

function normalizeImportedProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const name = String(product.name || product.title || '').trim();
  if (!name) return null;

  const price = String(product.price || product.sale_price || product.regular_price || '').trim();
  const description = String(product.description || product.short_description || product.summary || '').trim();
  return {
    name,
    price,
    description,
    source: product.source || product.platform || 'import',
  };
}

function mergeImportedProducts(existingProducts = [], importedProducts = []) {
  const merged = [];
  const byKey = new Map();

  for (const product of [...existingProducts, ...importedProducts].map(normalizeImportedProduct).filter(Boolean)) {
    const key = normalizeProductText(product.name);
    if (!key) continue;

    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...product });
      merged.push(byKey.get(key));
      continue;
    }

    if (!current.price && product.price) current.price = product.price;
    if (product.description && !current.description.includes(product.description)) {
      current.description = [current.description, product.description].filter(Boolean).join('\n');
    }
    if (!current.source && product.source) current.source = product.source;
  }

  return merged;
}

function organizeProductsForConfig(config = {}, importedProducts = []) {
  const imported = Array.isArray(importedProducts) ? importedProducts : [];
  const products = mergeImportedProducts(config.products, imported);
  const catalog = buildProductCatalog({
    ...config,
    products,
  });

  return {
    ...config,
    products: catalog.map(product => ({
      name: product.name,
      price: product.price || '',
      description: product.description || '',
      source: product.source || 'platform',
    })),
  };
}

module.exports = {
  mergeImportedProducts,
  organizeProductsForConfig,
};
