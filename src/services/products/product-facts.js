'use strict';

const crypto = require('node:crypto');
const {
  buildProductCatalog,
  normalizeProductText,
} = require('./product-knowledge');

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const NUMBER_WORDS = new Map([
  ['واحد', 1], ['واحده', 1],
  ['اثنين', 2], ['اثنان', 2], ['شهرين', 2],
  ['ثلاث', 3], ['ثلاثه', 3],
  ['اربع', 4], ['اربعه', 4],
  ['خمس', 5], ['خمسه', 5],
  ['ست', 6], ['سته', 6],
  ['سبع', 7], ['سبعه', 7],
  ['ثمان', 8], ['ثمانيه', 8],
  ['تسع', 9], ['تسعه', 9],
  ['عشر', 10], ['عشره', 10],
  ['احد عشر', 11], ['اثنا عشر', 12], ['اثني عشر', 12],
]);

function normalizeDigits(value) {
  return String(value || '').replace(/[٠-٩۰-۹]/g, digit => {
    const arabicIndex = ARABIC_DIGITS.indexOf(digit);
    return String(arabicIndex >= 0 ? arabicIndex : PERSIAN_DIGITS.indexOf(digit));
  });
}

function stableLegacyId(prefix, value) {
  const digest = crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeProductText(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function parseDuration(value) {
  const normalized = normalizeProductText(normalizeDigits(value));
  if (!normalized) return null;

  if (/(?:^|\s)(?:سنه|عام)(?:\s|$)/.test(normalized)) {
    const numberMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:سنه|عام)/);
    return { value: numberMatch ? Number(numberMatch[1]) : 1, unit: 'year' };
  }

  const monthNumber = normalized.match(/(\d+(?:\.\d+)?)\s*(?:شهر|اشهر)/);
  if (monthNumber) return { value: Number(monthNumber[1]), unit: 'month' };
  if (/(?:^|\s)شهرين(?:\s|$)/.test(normalized)) return { value: 2, unit: 'month' };

  for (const [word, number] of NUMBER_WORDS) {
    if (new RegExp(`(?:^|\\s)${word}\\s*(?:شهر|اشهر)(?:\\s|$)`).test(normalized)) {
      return { value: number, unit: 'month' };
    }
  }
  return null;
}

function parseCurrency(value, fallback = 'SAR') {
  const normalized = normalizeProductText(value);
  if (/(?:usd|دولار)/i.test(normalized) || /\$/.test(String(value || ''))) return 'USD';
  if (/(?:aed|درهم)/i.test(normalized)) return 'AED';
  if (/(?:sar|ريال|ر س)/i.test(normalized) || /﷼/.test(String(value || ''))) return 'SAR';
  return String(fallback || 'SAR').trim().toUpperCase();
}

function parsePrice(value, fallbackCurrency = 'SAR') {
  const normalized = normalizeDigits(value).replace(/,/g, '');
  const amountMatch = normalized.match(/\d+(?:\.\d+)?/);
  if (!amountMatch) return null;
  return {
    amount: Number(amountMatch[0]),
    currency: parseCurrency(value, fallbackCurrency),
  };
}

function normalizePlan(product, variant, index, defaultCurrency) {
  const label = String(variant?.label || product?.description || product?.longDescription || '').trim();
  const price = parsePrice(variant?.price ?? product?.price, variant?.currency || product?.currency || defaultCurrency);
  const productId = String(product?.id || product?.productId || '').trim()
    || stableLegacyId('product', normalizeProductText(product?.name));
  const planId = String(variant?.id || variant?.planId || '').trim()
    || stableLegacyId('plan', `${productId}|${normalizeProductText(label)}|${price?.amount ?? ''}|${price?.currency ?? ''}|${index}`);

  return {
    planId,
    label,
    duration: parseDuration(label),
    price,
    available: product?.available !== false && variant?.available !== false,
  };
}

function normalizeProduct(product, index, defaultCurrency) {
  const canonicalName = String(product?.name || '').trim();
  const conciseName = canonicalName.replace(/^(?:اشتراك|خدمه|خدمة|منتج|باقه|باقة)\s+/u, '').trim();
  const productId = String(product?.id || product?.productId || '').trim()
    || stableLegacyId('product', normalizeProductText(canonicalName) || index);
  const variants = Array.isArray(product?.variants) && product.variants.length
    ? product.variants
    : [{ label: product?.description || product?.longDescription || '', price: product?.price, available: product?.available }];

  return {
    productId,
    canonicalName,
    aliases: uniqueStrings([canonicalName, conciseName, ...(Array.isArray(product?.aliases) ? product.aliases : [])]),
    description: String(product?.description || '').trim(),
    longDescription: String(product?.longDescription || '').trim(),
    url: String(product?.url || '').trim(),
    available: product?.available !== false,
    plans: variants
      .map((variant, variantIndex) => normalizePlan({ ...product, id: productId }, variant, variantIndex, defaultCurrency))
      .filter(plan => plan.label || plan.price),
  };
}

function buildProductFactCatalog(config = {}, { catalogVersion = 0 } = {}) {
  const products = buildProductCatalog(config)
    .map((product, index) => normalizeProduct(product, index, config.currency || 'SAR'))
    .filter(product => product.canonicalName);
  return {
    version: Number.isFinite(Number(catalogVersion)) ? Number(catalogVersion) : 0,
    products,
  };
}

function matchingProductIds(catalog, text) {
  const normalizedText = normalizeProductText(text);
  if (!normalizedText) return [];
  const matches = [];
  for (const product of catalog?.products || []) {
    const matched = product.aliases.some(alias => {
      const normalizedAlias = normalizeProductText(alias);
      return normalizedAlias.length >= 2 && normalizedText.includes(normalizedAlias);
    });
    if (matched) matches.push(product.productId);
  }
  return [...new Set(matches)];
}

function focusResult(productIds, source) {
  if (productIds.length === 1) return { status: 'resolved', source, productIds };
  if (productIds.length > 1) return { status: 'ambiguous', source, productIds };
  return { status: 'unknown', source: 'none', productIds: [] };
}

function resolveProductFocus({ catalog, history = [], customerText = '' } = {}) {
  const currentMatches = matchingProductIds(catalog, customerText);
  if (currentMatches.length) return focusResult(currentMatches, 'current');

  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index] || {};
    if (!['user', 'customer'].includes(String(message.role || '').toLowerCase())) continue;
    const matches = matchingProductIds(catalog, message.content);
    if (matches.length) return focusResult(matches, 'history');
  }
  return focusResult([], 'none');
}

function buildScopedProductContext({ catalog, focus } = {}) {
  const selected = focus?.status === 'resolved'
    ? (catalog?.products || []).filter(product => focus.productIds.includes(product.productId))
    : [];
  return {
    catalogVersion: Number(catalog?.version || 0),
    focus: {
      status: focus?.status || 'unknown',
      source: focus?.source || 'none',
      productIds: [...(focus?.productIds || [])],
    },
    products: selected.map(product => ({
      ...product,
      aliases: [...product.aliases],
      plans: product.plans.map(plan => ({
        ...plan,
        duration: plan.duration ? { ...plan.duration } : null,
        price: plan.price ? { ...plan.price } : null,
      })),
    })),
  };
}

module.exports = {
  buildProductFactCatalog,
  buildScopedProductContext,
  normalizeDigits,
  parseCurrency,
  parseDuration,
  parsePrice,
  resolveProductFocus,
};
