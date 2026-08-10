'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeterministicCatalogReply,
  extractCommercialClaims,
  validateCommercialClaims,
} = require('../src/services/ai/product-claim-validator');
const {
  buildProductFactCatalog,
  resolveProductFocus,
} = require('../src/services/products/product-facts');

const CONFIG = {
  products: [
    {
      id: 'adobe',
      name: 'اشتراك أدوبي',
      variants: [
        { id: 'adobe-4m', label: '4 أشهر', price: '189 ريال', available: true },
        { id: 'adobe-8m', label: '8 أشهر', price: '319 ريال', available: true },
        { id: 'adobe-old', label: '3 أشهر', price: '149 ريال', available: false },
      ],
    },
    {
      id: 'freepik',
      name: 'اشتراك فري بيك',
      variants: [
        { id: 'freepik-6m', label: '6 أشهر', price: '89 ريال', available: true },
        { id: 'freepik-1y', label: 'سنة', price: '139 ريال', available: true },
      ],
    },
  ],
};

function context(customerText = 'أبي أدوبي') {
  const catalog = buildProductFactCatalog(CONFIG, { catalogVersion: 9 });
  const focus = resolveProductFocus({ catalog, history: [], customerText });
  return { catalog, focus };
}

test('extractCommercialClaims binds multiple duration/price pairs to the resolved product', () => {
  const { catalog, focus } = context();
  const claims = extractCommercialClaims(
    'أدوبي متوفر: 4 أشهر بـ189 ريال، و8 أشهر بـ319 ريال.',
    { catalog, focus },
  );

  assert.deepEqual(
    claims.map(claim => ({
      productId: claim.productId,
      duration: claim.duration,
      amount: claim.price?.amount,
      currency: claim.price?.currency,
    })),
    [
      { productId: 'adobe', duration: { value: 4, unit: 'month' }, amount: 189, currency: 'SAR' },
      { productId: 'adobe', duration: { value: 8, unit: 'month' }, amount: 319, currency: 'SAR' },
    ],
  );
});

test('validateCommercialClaims accepts only complete Adobe tuples', () => {
  const { catalog, focus } = context();
  const result = validateCommercialClaims(
    'أدوبي: 4 أشهر بـ189 ريال، و8 أشهر بـ319 ريال.',
    { catalog, focus },
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.claims.map(claim => claim.matchedPlanId), ['adobe-4m', 'adobe-8m']);
});

for (const [name, reply, reason] of [
  ['cross-product six-month price', 'أدوبي 6 أشهر بـ89 ريال.', 'plan_not_found'],
  ['cross-product annual price', 'أدوبي سنة بـ139 ريال.', 'plan_not_found'],
  ['stale Adobe price', 'أدوبي 8 أشهر بـ289 ريال.', 'tuple_mismatch'],
  ['unavailable Adobe plan', 'أدوبي 3 أشهر بـ149 ريال متوفر.', 'plan_unavailable'],
]) {
  test(`validateCommercialClaims rejects ${name}`, () => {
    const { catalog, focus } = context();
    const result = validateCommercialClaims(reply, { catalog, focus });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(issue => issue.reason === reason));
  });
}

test('validateCommercialClaims rejects prices when product focus is ambiguous', () => {
  const { catalog, focus } = context('كم أدوبي وفري بيك؟');
  const result = validateCommercialClaims('السعر 189 ريال.', { catalog, focus });

  assert.equal(focus.status, 'ambiguous');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.reason === 'product_ambiguous'));
});

test('buildDeterministicCatalogReply lists only the resolved product plans', () => {
  const { catalog, focus } = context();
  const result = buildDeterministicCatalogReply({
    customerText: 'كم أسعار ومدد أدوبي؟',
    catalog,
    focus,
  });

  assert.equal(result.decision, 'answer');
  assert.match(result.reply, /4 أشهر.*189 ريال/s);
  assert.match(result.reply, /8 أشهر.*319 ريال/s);
  assert.doesNotMatch(result.reply, /(?:^|[^\d])(?:89|139)\s*ريال|فري بيك/);
});

test('buildDeterministicCatalogReply reports an unavailable requested duration without inventing a price', () => {
  const { catalog, focus } = context();
  const result = buildDeterministicCatalogReply({
    customerText: 'كم سعر السنة؟',
    catalog,
    focus,
  });

  assert.equal(result.decision, 'answer');
  assert.match(result.reply, /السنة.*غير متوفرة|لا توجد.*سنة/);
  assert.doesNotMatch(result.reply, /\d+\s*ريال/);
});

test('buildDeterministicCatalogReply asks which product when focus is unknown', () => {
  const catalog = buildProductFactCatalog(CONFIG);
  const focus = resolveProductFocus({ catalog, history: [], customerText: 'كم السنة؟' });
  const result = buildDeterministicCatalogReply({
    customerText: 'كم السنة؟',
    catalog,
    focus,
  });

  assert.equal(result.decision, 'clarify');
  assert.match(result.reply, /أي منتج|اسم المنتج/);
  assert.doesNotMatch(result.reply, /\d+\s*ريال/);
});
