'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMetrics, isQualifiedPurchase, DEFAULT_QUALIFIED_STATUSES } = require('../src/services/identity/customer-metrics');

const T = (s) => new Date(s);

test('qualification policy: only qualifying Salla statuses count as a purchase', () => {
  assert.equal(isQualifiedPurchase('completed'), true);
  assert.equal(isQualifiedPurchase('delivered'), true);
  assert.equal(isQualifiedPurchase('canceled'), false);
  assert.equal(isQualifiedPurchase('payment_failed'), false);
  assert.equal(isQualifiedPurchase('payment_pending'), false);
  assert.ok(DEFAULT_QUALIFIED_STATUSES.includes('completed'));
});

test('a cancelled/failed order does NOT make someone a buyer', () => {
  const m = computeMetrics({ orders: [{ statusSlug: 'canceled', totalAmount: 100, placedAt: T('2026-08-01') }] });
  assert.equal(m.has_orders, false);
  assert.equal(m.orders_count, 0);
  assert.equal(m.segments.asked_not_ordered, false); // no conversation either
});

test('conversation but no order → "سأل ولم يطلب"', () => {
  const m = computeMetrics({
    orders: [],
    conversation: { hasConversation: true, firstConversationAt: T('2026-08-10T10:00:00Z'), firstContactAt: T('2026-08-10T10:00:00Z'), lastMessageAt: T('2026-08-10T10:05:00Z'), conversationCount: 1 },
  });
  assert.equal(m.segments.asked_not_ordered, true);
  assert.equal(m.has_whatsapp_conversation, true);
  assert.equal(m.lifecycle, 'Engaged Lead');
});

test('contacted before purchase → "سأل ثم طلب" with conversion timing', () => {
  const m = computeMetrics({
    orders: [{ statusSlug: 'completed', totalAmount: 150, placedAt: T('2026-08-10T15:18:00Z'), sallaOrderId: '28192', items: [{ name: 'اشتراك' }] }],
    conversation: { hasConversation: true, firstContactAt: T('2026-08-10T13:20:00Z'), firstConversationAt: T('2026-08-10T13:20:00Z'), lastMessageAt: T('2026-08-10T15:00:00Z'), conversationCount: 1 },
  });
  assert.equal(m.segments.asked_then_ordered, true);
  assert.equal(m.segments.ordered_then_contacted, false);
  assert.equal(m.contacted_before_purchase, true);
  assert.equal(m.time_to_conversion_seconds, (T('2026-08-10T15:18:00Z') - T('2026-08-10T13:20:00Z')) / 1000);
  assert.equal(m.conversion_order_id, '28192');
  assert.equal(m.first_product, 'اشتراك');
});

test('ordered first, contacted later → "طلب ثم تواصل" (NOT سأل ثم طلب)', () => {
  const m = computeMetrics({
    orders: [{ statusSlug: 'completed', totalAmount: 150, placedAt: T('2026-08-10T15:00:00Z') }],
    conversation: { hasConversation: true, firstContactAt: T('2026-08-10T17:00:00Z'), firstConversationAt: T('2026-08-10T17:00:00Z'), lastMessageAt: T('2026-08-10T17:05:00Z'), conversationCount: 1 },
  });
  assert.equal(m.segments.ordered_then_contacted, true);
  assert.equal(m.segments.asked_then_ordered, false);
  assert.equal(m.contacted_before_purchase, false);
});

test('ordered, never contacted → "طلب بدون تواصل"', () => {
  const m = computeMetrics({
    orders: [{ statusSlug: 'delivered', totalAmount: 90, placedAt: T('2026-08-09') }],
    conversation: { hasConversation: false },
  });
  assert.equal(m.segments.ordered_no_contact, true);
  assert.equal(m.segments.ordered_then_contacted, false);
  assert.equal(m.segments.asked_then_ordered, false);
});

test('two qualifying orders → Repeat Customer', () => {
  const m = computeMetrics({
    orders: [
      { statusSlug: 'completed', totalAmount: 100, placedAt: T('2026-06-01') },
      { statusSlug: 'completed', totalAmount: 200, placedAt: T('2026-07-01') },
    ],
  });
  assert.equal(m.orders_count, 2);
  assert.equal(m.total_order_value, 300);
  assert.equal(m.avg_order_value, 150);
  assert.equal(m.last_order_value, 200);
  assert.equal(m.lifecycle, 'Repeat Customer');
});

test('abandoned cart, no purchase vs recovered cart', () => {
  const abandoned = computeMetrics({ orders: [], carts: [{ status: 'abandoned', totalAmount: 80, abandonedAt: T('2026-08-10') }] });
  assert.equal(abandoned.has_abandoned_cart, true);
  assert.equal(abandoned.segments.cart_abandoned_no_purchase, true);
  assert.equal(abandoned.lifecycle, 'Abandoned Cart Lead');

  const recovered = computeMetrics({
    orders: [{ statusSlug: 'completed', totalAmount: 80, placedAt: T('2026-08-11') }],
    carts: [{ status: 'purchased', totalAmount: 80, abandonedAt: T('2026-08-10'), convertedAt: T('2026-08-11') }],
  });
  assert.equal(recovered.cart_recovered, true);
  assert.equal(recovered.segments.cart_recovered_then_purchased, true);
  assert.equal(recovered.lifecycle, 'Recovered Customer');
});

test('attribution window is a lens applied over raw timings, not hardcoded', () => {
  const input = {
    orders: [{ statusSlug: 'completed', totalAmount: 10, placedAt: T('2026-08-20T00:00:00Z') }],
    conversation: { hasConversation: true, firstContactAt: T('2026-08-01T00:00:00Z'), firstConversationAt: T('2026-08-01T00:00:00Z') },
  };
  // Fact stays: contacted before purchase, ~19 days apart.
  const m = computeMetrics(input);
  assert.equal(m.contacted_before_purchase, true);
  // A 7-day attribution window would NOT credit this chat; a 30-day one would.
  const secs = m.time_to_conversion_seconds;
  assert.ok(secs > 7 * 86400 && secs < 30 * 86400);
});
