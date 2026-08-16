'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileRules, QUICK_SEGMENTS, SEGMENT_SQL } = require('../src/services/identity/segment-rules');

test('empty / undefined rules compile to TRUE (match everyone)', () => {
  assert.equal(compileRules().sql, 'TRUE');
  assert.equal(compileRules({}).sql, 'TRUE');
  assert.equal(compileRules({ conditions: [] }).sql, 'TRUE');
});

test('a segment virtual field expands to its predicate (no params)', () => {
  const r = compileRules({ segment: 'asked_not_ordered' });
  assert.equal(r.sql, SEGMENT_SQL.asked_not_ordered);
  assert.deepEqual(r.params, []);
});

test('numeric comparison is parameterized', () => {
  const r = compileRules({ field: 'orders_count', operator: 'gte', value: 2 });
  assert.equal(r.sql, 'm.orders_count >= $1');
  assert.deepEqual(r.params, [2]);
});

test('boolean fields render as IS TRUE/FALSE without a param', () => {
  assert.equal(compileRules({ field: 'has_orders', operator: 'is', value: true }).sql, 'm.has_orders IS TRUE');
  assert.equal(compileRules({ field: 'has_orders', operator: 'is', value: false }).sql, 'm.has_orders IS FALSE');
});

test('AND / OR groups with nesting and correct param numbering', () => {
  const r = compileRules({
    op: 'and',
    conditions: [
      { segment: 'asked_not_ordered' },
      { op: 'or', conditions: [
        { field: 'total_order_value', operator: 'gt', value: 100 },
        { field: 'lifecycle', operator: 'eq', value: 'Repeat Customer' },
      ] },
    ],
  });
  assert.equal(
    r.sql,
    `(${SEGMENT_SQL.asked_not_ordered} AND (m.total_order_value > $1 OR m.lifecycle = $2))`,
  );
  assert.deepEqual(r.params, [100, 'Repeat Customer']);
});

test('date within_days uses an interval expression', () => {
  const r = compileRules({ field: 'last_message_at', operator: 'within_days', value: 30 });
  assert.equal(r.sql, "m.last_message_at >= NOW() - ($1 * INTERVAL '1 day')");
  assert.deepEqual(r.params, [30]);
});

test('in-list operator uses = ANY($n)', () => {
  const r = compileRules({ field: 'lifecycle', operator: 'in', value: ['Lead', 'Engaged Lead'] });
  assert.equal(r.sql, 'm.lifecycle = ANY($1)');
  assert.deepEqual(r.params, [['Lead', 'Engaged Lead']]);
});

test('injection safety: unknown field / operator / segment throw', () => {
  assert.throws(() => compileRules({ field: 'm.password; DROP TABLE', operator: 'eq', value: 1 }), /unknown_field/);
  assert.throws(() => compileRules({ field: 'orders_count', operator: 'evil', value: 1 }), /unknown_operator/);
  assert.throws(() => compileRules({ segment: 'x; DROP TABLE' }), /unknown_segment/);
});

test('quick segments are defined for the §24 ready-made lists', () => {
  const keys = QUICK_SEGMENTS.map((s) => s.key);
  for (const k of ['all', 'buyers', 'non_buyers', 'asked_not_ordered', 'asked_then_ordered', 'ordered_then_contacted', 'ordered_no_contact', 'cart_abandoned_no_purchase', 'cart_recovered_then_purchased', 'repeat_customer']) {
    assert.ok(keys.includes(k), `missing quick segment ${k}`);
  }
  // Every quick segment must compile.
  for (const s of QUICK_SEGMENTS) assert.doesNotThrow(() => compileRules(s.rules));
});
