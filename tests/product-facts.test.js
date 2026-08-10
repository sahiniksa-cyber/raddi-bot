'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProductFactCatalog,
  buildScopedProductContext,
  resolveProductFocus,
} = require('../src/services/products/product-facts');

const CONFIG = {
  products: [
    {
      id: 'adobe',
      name: 'اشتراك أدوبي',
      aliases: ['Adobe', 'ادوبى'],
      available: true,
      variants: [
        { id: 'adobe-4m', label: 'اشتراك 4 أشهر', price: '189 ريال', available: true },
        { id: 'adobe-8m', label: 'اشتراك 8 أشهر', price: '319 ريال', available: true },
      ],
    },
    {
      id: 'freepik',
      name: 'اشتراك فري بيك',
      aliases: ['Freepik', 'فريبيك'],
      available: true,
      variants: [
        { id: 'freepik-6m', label: 'اشتراك 6 أشهر', price: '89 ريال', available: true },
        { id: 'freepik-1y', label: 'اشتراك سنة', price: '139 ريال', available: true },
      ],
    },
  ],
};

test('buildProductFactCatalog keeps each price and duration attached to one product plan', () => {
  const catalog = buildProductFactCatalog(CONFIG, { catalogVersion: 17 });

  assert.equal(catalog.version, 17);
  assert.deepEqual(catalog.products[0], {
    productId: 'adobe',
    canonicalName: 'اشتراك أدوبي',
    aliases: ['اشتراك أدوبي', 'أدوبي'],
    description: '',
    longDescription: '',
    url: '',
    available: true,
    plans: [
      {
        planId: 'adobe-4m',
        label: 'اشتراك 4 أشهر',
        duration: { value: 4, unit: 'month' },
        price: { amount: 189, currency: 'SAR' },
        available: true,
      },
      {
        planId: 'adobe-8m',
        label: 'اشتراك 8 أشهر',
        duration: { value: 8, unit: 'month' },
        price: { amount: 319, currency: 'SAR' },
        available: true,
      },
    ],
  });
  assert.equal(catalog.products[1].plans[0].price.amount, 89);
  assert.equal(catalog.products[1].plans[0].duration.value, 6);
});

test('resolveProductFocus carries the last explicit product into a duration-only follow-up', () => {
  const catalog = buildProductFactCatalog(CONFIG);
  const focus = resolveProductFocus({
    catalog,
    history: [
      { role: 'user', content: 'أدور على اشتراك أدوبي' },
      { role: 'assistant', content: 'متوفر، أي مدة تناسبك؟' },
    ],
    customerText: 'كم السنة وكم الست أشهر؟',
  });

  assert.equal(focus.status, 'resolved');
  assert.equal(focus.source, 'history');
  assert.deepEqual(focus.productIds, ['adobe']);
});

test('resolveProductFocus treats two explicit products as ambiguous instead of blending them', () => {
  const catalog = buildProductFactCatalog(CONFIG);
  const focus = resolveProductFocus({
    catalog,
    history: [],
    customerText: 'كم سعر أدوبي وفري بيك؟',
  });

  assert.equal(focus.status, 'ambiguous');
  assert.deepEqual(new Set(focus.productIds), new Set(['adobe', 'freepik']));
});

test('aliases identify only their owning product', () => {
  const catalog = buildProductFactCatalog(CONFIG);
  const focus = resolveProductFocus({
    catalog,
    history: [],
    customerText: 'Freepik كم الست أشهر؟',
  });

  assert.equal(focus.status, 'resolved');
  assert.deepEqual(focus.productIds, ['freepik']);
});

test('buildScopedProductContext exposes only the resolved product and never another product price', () => {
  const catalog = buildProductFactCatalog(CONFIG, { catalogVersion: 22 });
  const focus = resolveProductFocus({
    catalog,
    history: [{ role: 'user', content: 'أبي أدوبي' }],
    customerText: 'وش الخيارات؟',
  });
  const context = buildScopedProductContext({ catalog, focus });

  assert.equal(context.catalogVersion, 22);
  assert.equal(context.products.length, 1);
  assert.equal(context.products[0].productId, 'adobe');
  assert.deepEqual(context.products[0].plans.map(plan => plan.price.amount), [189, 319]);
  assert.ok(context.products.every(product => product.productId !== 'freepik'));
  assert.ok(context.products[0].plans.every(plan => ![89, 139].includes(plan.price.amount)));
});

test('buildScopedProductContext with unknown focus does not expose catalog prices', () => {
  const catalog = buildProductFactCatalog(CONFIG);
  const focus = resolveProductFocus({
    catalog,
    history: [],
    customerText: 'كم السعر؟',
  });
  const context = buildScopedProductContext({ catalog, focus });

  assert.equal(focus.status, 'unknown');
  assert.deepEqual(context.products, []);
});
