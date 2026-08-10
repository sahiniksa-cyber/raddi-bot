'use strict';

/**
 * Salla ingest orchestration — turns a Salla customer/order/cart record into
 * canonical CRM state: resolve identity → upsert the mirror row (crm_orders /
 * crm_carts) → append a timeline event → recompute the customer's metrics
 * (which re-derives segments/lifecycle). Used by BOTH the webhook handlers
 * (incremental) and the initial background sync (bulk).
 *
 * All collaborators are injectable so the orchestration is unit-tested without
 * a database or network.
 */

const db = require('../../db/client');
const defaultResolver = require('../identity/identity-resolver');
const defaultMetrics = require('../identity/customer-metrics');
const { mapSallaCustomerToSignal, mapSallaOrder, mapSallaCart } = require('./salla-api');

async function ingestCustomer(userId, sallaCustomer, deps = {}) {
  const resolver = deps.resolver || defaultResolver;
  const sig = mapSallaCustomerToSignal(sallaCustomer);
  const { customerId } = await resolver.resolveCustomer(userId, sig, deps);
  return customerId;
}

async function ingestOrder(userId, sallaOrder, deps = {}) {
  const database = deps.database || db;
  const resolver = deps.resolver || defaultResolver;
  const metrics = deps.metrics || defaultMetrics;
  const o = mapSallaOrder(sallaOrder);
  const { customerId } = await resolver.resolveCustomer(userId, {
    sallaCustomerId: o.sallaCustomerId,
    phone: o.customerPhone,
    occurredAt: o.placedAt || undefined,
    source: 'salla_order',
  }, deps);

  const qualified = metrics.isQualifiedPurchase(o.statusSlug, deps.qualifiedStatuses);
  await database.query(
    `INSERT INTO crm_orders
       (user_id, customer_id, salla_order_id, reference_id, status_slug, status_raw,
        is_qualified_purchase, total_amount, currency, items, coupon_code, placed_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (user_id, salla_order_id) DO UPDATE SET
       customer_id=EXCLUDED.customer_id, reference_id=EXCLUDED.reference_id,
       status_slug=EXCLUDED.status_slug, status_raw=EXCLUDED.status_raw,
       is_qualified_purchase=EXCLUDED.is_qualified_purchase, total_amount=EXCLUDED.total_amount,
       currency=EXCLUDED.currency, items=EXCLUDED.items, coupon_code=EXCLUDED.coupon_code,
       placed_at=EXCLUDED.placed_at, updated_at=NOW()`,
    [userId, customerId, o.sallaOrderId, o.referenceId, o.statusSlug, JSON.stringify(o.statusRaw || {}),
      qualified, o.totalAmount, o.currency, JSON.stringify(o.items || []), o.couponCode, o.placedAt],
  );
  await addTimelineEvent(database, userId, customerId, {
    eventType: 'order_created', occurredAt: o.placedAt, source: 'salla',
    refType: 'order', refId: o.sallaOrderId,
    detail: { status: o.statusSlug, total: o.totalAmount, currency: o.currency },
  });
  await metrics.recomputeCustomer(userId, customerId, deps);
  return { customerId, qualified };
}

// status: 'abandoned' | 'purchased' | 'recovered'
async function ingestCart(userId, sallaCart, status, deps = {}) {
  const database = deps.database || db;
  const resolver = deps.resolver || defaultResolver;
  const metrics = deps.metrics || defaultMetrics;
  const c = mapSallaCart(sallaCart);
  const { customerId } = await resolver.resolveCustomer(userId, {
    sallaCustomerId: c.sallaCustomerId,
    phone: c.customerPhone,
    occurredAt: c.abandonedAt || undefined,
    source: 'salla_cart',
  }, deps);

  const converted = status === 'purchased' || status === 'recovered';
  await database.query(
    `INSERT INTO crm_carts
       (user_id, customer_id, salla_cart_id, total_amount, currency, status, checkout_url,
        abandoned_at, converted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, salla_cart_id) DO UPDATE SET
       customer_id=EXCLUDED.customer_id, total_amount=EXCLUDED.total_amount,
       currency=EXCLUDED.currency, status=EXCLUDED.status, checkout_url=EXCLUDED.checkout_url,
       abandoned_at=COALESCE(crm_carts.abandoned_at, EXCLUDED.abandoned_at),
       converted_at=COALESCE(EXCLUDED.converted_at, crm_carts.converted_at), updated_at=NOW()`,
    [userId, customerId, c.sallaCartId, c.totalAmount, c.currency, status, c.checkoutUrl,
      c.abandonedAt, converted ? (deps.now ? new Date(deps.now()) : new Date()) : null],
  );
  await addTimelineEvent(database, userId, customerId, {
    eventType: converted ? 'cart_recovered' : 'cart_abandoned',
    occurredAt: c.abandonedAt, source: 'salla', refType: 'cart', refId: c.sallaCartId,
    detail: { total: c.totalAmount, currency: c.currency, status },
  });
  await metrics.recomputeCustomer(userId, customerId, deps);
  return { customerId, status };
}

async function addTimelineEvent(database, userId, customerId, ev) {
  await database.query(
    `INSERT INTO crm_timeline_events (user_id, customer_id, event_type, occurred_at, source, ref_type, ref_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (user_id, event_type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
    [userId, customerId, ev.eventType, ev.occurredAt || new Date(), ev.source || 'system',
      ev.refType || null, ev.refId || null, JSON.stringify(ev.detail || {})],
  );
}

// Route a raw Salla webhook body to the right ingest fn. Returns a small summary
// or null when the event isn't a CRM event.
async function ingestWebhookEvent(userId, body, deps = {}) {
  const event = body && body.event;
  const data = (body && body.data) || {};
  if (!event) return null;
  if (event === 'customer.created' || event === 'customer.updated') {
    const customerId = await ingestCustomer(userId, data, deps);
    return { kind: 'customer', customerId };
  }
  if (event.startsWith('order.')) {
    return { kind: 'order', ...(await ingestOrder(userId, data, deps)) };
  }
  if (event === 'abandoned.cart' || event === 'abandoned.cart.updated') {
    return { kind: 'cart', ...(await ingestCart(userId, data, 'abandoned', deps)) };
  }
  if (event === 'abandoned.cart.purchased' || event === 'abandoned.cart.converted') {
    return { kind: 'cart', ...(await ingestCart(userId, data, 'purchased', deps)) };
  }
  return null;
}

module.exports = { ingestCustomer, ingestOrder, ingestCart, ingestWebhookEvent, addTimelineEvent };
