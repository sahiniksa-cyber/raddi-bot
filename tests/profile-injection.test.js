'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AIClient = require('../lib/ai-client');
const { canonicalConfig } = require('./helpers/canonical-config');

function makeClient(overrides = {}) {
  const config = {
    ...canonicalConfig(),
    storeName: 'متجري',
    model: 'google/gemini-2.0-flash',
    googleApiKey: 'AIzaSyDummyKeyForTesting1234',
    products: [{ name: 'منتج', price: '50' }],
    ...overrides,
  };
  return new AIClient(
    config,
    { info: () => {}, warn: () => {}, error: () => {} },
    { record: () => {}, save: () => {} },
  );
}

test('system prompt includes profile section when opts.customerProfile is set', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  delete process.env.CUSTOMER_PROFILE_ENABLED; // default = enabled
  try {
    const ai = makeClient();
    const prompt = ai.buildSystemPrompt([], {
      customerProfile: { name: 'خالد', email: 'k@x.com', last_order_ref: 'A1' },
    });
    assert.ok(prompt.includes('معلومات محفوظة عن هذا العميل'), 'expected profile heading in prompt');
    assert.ok(prompt.includes('الاسم: خالد'));
    assert.ok(prompt.includes('الإيميل: k@x.com'));
    assert.ok(prompt.includes('آخر مرجع طلب: A1'));
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});

test('system prompt does NOT include profile section when no profile is passed', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  delete process.env.CUSTOMER_PROFILE_ENABLED;
  try {
    const ai = makeClient();
    const prompt = ai.buildSystemPrompt([], {});
    assert.ok(!prompt.includes('معلومات محفوظة عن هذا العميل'), 'profile heading must NOT appear without a profile');
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});

test('system prompt does NOT include profile section when profile is empty object', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  delete process.env.CUSTOMER_PROFILE_ENABLED;
  try {
    const ai = makeClient();
    const prompt = ai.buildSystemPrompt([], { customerProfile: {} });
    assert.ok(!prompt.includes('معلومات محفوظة عن هذا العميل'));
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});

test('system prompt does NOT include profile section when CUSTOMER_PROFILE_ENABLED=false even with profile', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  process.env.CUSTOMER_PROFILE_ENABLED = 'false';
  try {
    const ai = makeClient();
    const prompt = ai.buildSystemPrompt([], {
      customerProfile: { name: 'خالد', email: 'k@x.com' },
    });
    assert.ok(!prompt.includes('معلومات محفوظة عن هذا العميل'), 'flag=false must suppress profile section');
    assert.ok(!prompt.includes('خالد'));
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});

test('profile injection works with the long-custom-instructions branch too', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  delete process.env.CUSTOMER_PROFILE_ENABLED;
  try {
    const longInstructions = 'أ'.repeat(120); // > 80 chars triggers the custom branch
    const ai = makeClient({ botInstructions: longInstructions });
    const prompt = ai.buildSystemPrompt([], {
      customerProfile: { name: 'سارة' },
    });
    assert.ok(prompt.includes('معلومات محفوظة عن هذا العميل'));
    assert.ok(prompt.includes('الاسم: سارة'));
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});

test('profile injection only renders fields that are present', () => {
  const prev = process.env.CUSTOMER_PROFILE_ENABLED;
  delete process.env.CUSTOMER_PROFILE_ENABLED;
  try {
    const ai = makeClient();
    const prompt = ai.buildSystemPrompt([], {
      customerProfile: { name: 'خالد' }, // only name
    });
    assert.ok(prompt.includes('الاسم: خالد'));
    assert.ok(!prompt.includes('الإيميل:'), 'email line must be omitted when not in profile');
    assert.ok(!prompt.includes('آخر مرجع طلب:'), 'order line must be omitted when not in profile');
  } finally {
    if (prev === undefined) delete process.env.CUSTOMER_PROFILE_ENABLED;
    else process.env.CUSTOMER_PROFILE_ENABLED = prev;
  }
});
