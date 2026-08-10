'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/campaigns/campaign-service');

test('normalizeAudienceRules accepts crm_segment with a quick key', () => {
  const n = svc.normalizeAudienceRules({ source: 'crm_segment', segmentKey: 'asked_not_ordered' });
  assert.equal(n.source, 'crm_segment');
  assert.equal(n.segmentKey, 'asked_not_ordered');
});

test('normalizeAudienceRules rejects an unknown segment key and an empty segment', () => {
  assert.throws(() => svc.normalizeAudienceRules({ source: 'crm_segment', segmentKey: 'nope' }));
  assert.throws(() => svc.normalizeAudienceRules({ source: 'crm_segment' }));
});

test('normalizeAudienceRules validates inline segment rules (injection-safe)', () => {
  assert.doesNotThrow(() => svc.normalizeAudienceRules({ source: 'crm_segment', segmentRules: { field: 'orders_count', operator: 'gte', value: 2 } }));
  assert.throws(() => svc.normalizeAudienceRules({ source: 'crm_segment', segmentRules: { field: 'DROP', operator: 'eq', value: 1 } }));
});

test('resolveCrmSegmentAudience maps canonical customers to sendable recipients', async () => {
  const db = { query: async () => ({ rows: [{ customer_id: 'c1', normalized_phone: '966501234567', customer_name: 'محمد' }] }) };
  const rows = await svc.resolveCrmSegmentAudience(db, 'u1', { source: 'crm_segment', segmentKey: 'asked_not_ordered' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, '966501234567@s.whatsapp.net');
  assert.equal(rows[0].customer_id, 'c1');
  assert.equal(rows[0].source, 'crm_segment');
});

test('resolveAudience dedupes crm_segment recipients by canonical customer_id', async () => {
  // Same customer returned twice (e.g. two identities) → one recipient.
  const db = { query: async () => ({ rows: [
    { customer_id: 'c1', normalized_phone: '966501234567', customer_name: 'a' },
    { customer_id: 'c1', normalized_phone: '966501234567', customer_name: 'a' },
  ] }) };
  const out = await svc.resolveAudience(db, 'u1', { source: 'crm_segment', segmentKey: 'all' });
  assert.equal(out.length, 1);
});

test('recipientMatchesCrmSegment: true when the customer still matches, false otherwise', async () => {
  const matches = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
  const noMatch = { query: async () => ({ rows: [] }) };
  assert.equal(await svc.recipientMatchesCrmSegment(matches, 'u1', 'c1', { source: 'crm_segment', segmentKey: 'asked_not_ordered' }), true);
  assert.equal(await svc.recipientMatchesCrmSegment(noMatch, 'u1', 'c1', { source: 'crm_segment', segmentKey: 'asked_not_ordered' }), false);
  // No customer_id → never eligible.
  assert.equal(await svc.recipientMatchesCrmSegment(noMatch, 'u1', null, { source: 'crm_segment', segmentKey: 'all' }), false);
});
