'use strict';

/**
 * Customer metrics + classification. `computeMetrics` is PURE (raw orders/carts/
 * conversation → the derived rollup + segment flags + lifecycle) so the
 * classification rules are exhaustively unit-tested. `recomputeCustomer` reads
 * the raw crm orders/carts + conversations rows for one customer and upserts the
 * result into crm_customer_metrics — fully rebuildable, nothing derived is
 * stored that can't be reproduced from raw sources.
 *
 * Purchase Qualification Policy (spec §32): only these Salla status slugs count
 * as a purchase. Configurable per call; merchant custom statuses tolerated
 * (unknown slugs are simply not qualified). Raw status is always kept on
 * crm_orders, so the policy can change and be recomputed without data loss.
 */

const db = require('../../db/client');

const DEFAULT_QUALIFIED_STATUSES = Object.freeze([
  'completed', 'delivered', 'shipped', 'delivering', 'in_progress',
]);

function isQualifiedPurchase(statusSlug, qualified = DEFAULT_QUALIFIED_STATUSES) {
  return Boolean(statusSlug) && qualified.includes(statusSlug);
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function ms(d) { return d ? d.getTime() : null; }

function computeMetrics(input = {}, opts = {}) {
  const qualified = opts.qualifiedStatuses || DEFAULT_QUALIFIED_STATUSES;
  const inactiveDays = opts.inactiveDays || 90;
  const now = opts.now ? toDate(opts.now) : null;

  const orders = (input.orders || []).map((o) => ({
    ...o, placedAt: toDate(o.placedAt), qualified: isQualifiedPurchase(o.statusSlug, qualified),
  }));
  const carts = (input.carts || []).map((c) => ({
    ...c, abandonedAt: toDate(c.abandonedAt), convertedAt: toDate(c.convertedAt),
  }));
  const conv = input.conversation || {};

  // ── Purchase dimension (qualified orders only) ──
  const qOrders = orders.filter((o) => o.qualified);
  const qWithDate = qOrders.filter((o) => o.placedAt).sort((a, b) => a.placedAt - b.placedAt);
  const ordersCount = qOrders.length;
  const hasOrders = ordersCount > 0;
  const firstOrder = qWithDate[0] || null;
  const lastOrder = qWithDate[qWithDate.length - 1] || null;
  const totalOrderValue = qOrders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0);
  const avgOrderValue = ordersCount ? totalOrderValue / ordersCount : 0;
  const allByDate = orders.filter((o) => o.placedAt).sort((a, b) => a.placedAt - b.placedAt);
  const mostRecentOrder = allByDate[allByDate.length - 1] || null;
  const itemNames = (o) => (Array.isArray(o && o.items) ? o.items.map((i) => i && (i.name || i.title)).filter(Boolean) : []);

  // ── Conversation dimension ──
  const hasConversation = Boolean(conv.hasConversation);
  const firstContactAt = toDate(conv.firstContactAt) || toDate(conv.firstConversationAt) || null;
  const firstConversationAt = toDate(conv.firstConversationAt) || firstContactAt;

  // ── Cart dimension ──
  const abandoned = carts.filter((c) => c.status === 'abandoned');
  const recoveredCarts = carts.filter((c) => c.status === 'purchased' || c.status === 'recovered');
  const lastAbandoned = abandoned.filter((c) => c.abandonedAt).sort((a, b) => a.abandonedAt - b.abandonedAt).pop() || abandoned[0] || null;
  const recoveredAt = recoveredCarts.map((c) => c.convertedAt).filter(Boolean).sort((a, b) => b - a)[0] || null;

  // ── Attribution (raw; window applied later at analysis time) ──
  const firstOrderAt = firstOrder ? firstOrder.placedAt : null;
  const contactedBeforePurchase = Boolean(firstContactAt && firstOrderAt && firstContactAt < firstOrderAt);
  const timeToConversion = contactedBeforePurchase ? Math.round((ms(firstOrderAt) - ms(firstContactAt)) / 1000) : null;

  // ── Segments (mutually-exclusive contact/purchase relationship) ──
  const segments = {
    asked_not_ordered: hasConversation && ordersCount === 0,
    asked_then_ordered: contactedBeforePurchase,
    ordered_then_contacted: hasOrders && hasConversation && !contactedBeforePurchase,
    ordered_no_contact: hasOrders && !hasConversation,
    cart_abandoned_no_purchase: abandoned.length > 0 && ordersCount === 0,
    cart_recovered_then_purchased: recoveredCarts.length > 0,
    repeat_customer: ordersCount >= 2,
  };

  // ── Lifecycle (derived; recomputed every change) ──
  let lifecycle;
  if (ordersCount >= 2) lifecycle = 'Repeat Customer';
  else if (ordersCount === 1) lifecycle = recoveredCarts.length > 0 ? 'Recovered Customer' : 'First-Time Customer';
  else if (abandoned.length > 0) lifecycle = 'Abandoned Cart Lead';
  else if (hasConversation) lifecycle = 'Engaged Lead';
  else lifecycle = 'Lead';

  if (now) {
    const lastActivity = Math.max(ms(toDate(conv.lastMessageAt)) || 0, ms(lastOrder && lastOrder.placedAt) || 0);
    if (lastActivity && now.getTime() - lastActivity > inactiveDays * 86400000) lifecycle = 'Inactive Customer';
  }

  return {
    has_orders: hasOrders,
    orders_count: ordersCount,
    first_order_at: firstOrderAt,
    last_order_at: lastOrder ? lastOrder.placedAt : null,
    last_order_status_slug: mostRecentOrder ? (mostRecentOrder.statusSlug || null) : null,
    total_order_value: round2(totalOrderValue),
    avg_order_value: round2(avgOrderValue),
    last_order_value: lastOrder ? (Number(lastOrder.totalAmount) || 0) : 0,
    first_product: firstOrder ? (itemNames(firstOrder)[0] || null) : null,
    last_products: lastOrder ? itemNames(lastOrder) : [],

    has_whatsapp_conversation: hasConversation,
    first_conversation_at: firstConversationAt,
    last_conversation_at: toDate(conv.lastConversationAt) || null,
    conversation_count: Number(conv.conversationCount) || 0,
    last_message_at: toDate(conv.lastMessageAt) || null,

    has_abandoned_cart: abandoned.length > 0,
    active_abandoned_carts_count: abandoned.length,
    last_abandoned_cart_at: lastAbandoned ? lastAbandoned.abandonedAt : null,
    last_abandoned_cart_value: lastAbandoned ? (Number(lastAbandoned.totalAmount) || null) : null,
    last_abandoned_cart_id: lastAbandoned ? (lastAbandoned.sallaCartId || null) : null,
    cart_recovered: recoveredCarts.length > 0,
    recovered_at: recoveredAt,

    first_contact_at: firstContactAt,
    contacted_before_purchase: hasOrders ? contactedBeforePurchase : null,
    time_to_conversion_seconds: timeToConversion,
    conversion_order_id: contactedBeforePurchase && firstOrder ? (firstOrder.sallaOrderId || null) : null,
    conversion_conversation_id: null,

    lifecycle,
    segments,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── DB-backed recompute (integration-tested via scenarios) ────────────────────
async function recomputeCustomer(userId, customerId, deps = {}) {
  const database = deps.database || db;
  const opts = { qualifiedStatuses: deps.qualifiedStatuses, now: deps.now, inactiveDays: deps.inactiveDays };

  const ordersRes = await database.query(
    `SELECT salla_order_id, status_slug, total_amount, items, placed_at
       FROM crm_orders WHERE user_id = $1 AND customer_id = $2`,
    [userId, customerId],
  );
  const cartsRes = await database.query(
    `SELECT salla_cart_id, status, total_amount, abandoned_at, converted_at
       FROM crm_carts WHERE user_id = $1 AND customer_id = $2`,
    [userId, customerId],
  );
  const convRes = await database.query(
    `SELECT COUNT(*)::int AS n, MIN(created_at) AS first_at,
            MAX(last_message_at) AS last_at
       FROM conversations WHERE user_id = $1 AND customer_id = $2`,
    [userId, customerId],
  );
  const contactRes = await database.query(
    `SELECT MIN(m.created_at) AS first_contact
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = $1 AND c.customer_id = $2 AND m.direction = 'inbound'`,
    [userId, customerId],
  );

  const convRow = convRes.rows[0] || {};
  const input = {
    orders: ordersRes.rows.map((o) => ({
      sallaOrderId: o.salla_order_id, statusSlug: o.status_slug,
      totalAmount: o.total_amount, items: o.items, placedAt: o.placed_at,
    })),
    carts: cartsRes.rows.map((c) => ({
      sallaCartId: c.salla_cart_id, status: c.status, totalAmount: c.total_amount,
      abandonedAt: c.abandoned_at, convertedAt: c.converted_at,
    })),
    conversation: {
      hasConversation: Number(convRow.n) > 0,
      conversationCount: Number(convRow.n) || 0,
      firstConversationAt: convRow.first_at,
      lastConversationAt: convRow.last_at,
      lastMessageAt: convRow.last_at,
      firstContactAt: (contactRes.rows[0] || {}).first_contact,
    },
  };

  const m = computeMetrics(input, opts);
  await upsertMetrics(userId, customerId, m, database);
  return m;
}

async function upsertMetrics(userId, customerId, m, database) {
  await database.query(
    `INSERT INTO crm_customer_metrics (
        customer_id, user_id, has_orders, orders_count, first_order_at, last_order_at,
        last_order_status_slug, total_order_value, avg_order_value, last_order_value,
        first_product, last_products, has_whatsapp_conversation, first_conversation_at,
        last_conversation_at, conversation_count, last_message_at, has_abandoned_cart,
        active_abandoned_carts_count, last_abandoned_cart_at, last_abandoned_cart_value,
        last_abandoned_cart_id, cart_recovered, recovered_at, first_contact_at,
        contacted_before_purchase, time_to_conversion_seconds, conversion_order_id,
        conversion_conversation_id, lifecycle, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW())
     ON CONFLICT (customer_id) DO UPDATE SET
        user_id=EXCLUDED.user_id, has_orders=EXCLUDED.has_orders, orders_count=EXCLUDED.orders_count,
        first_order_at=EXCLUDED.first_order_at, last_order_at=EXCLUDED.last_order_at,
        last_order_status_slug=EXCLUDED.last_order_status_slug, total_order_value=EXCLUDED.total_order_value,
        avg_order_value=EXCLUDED.avg_order_value, last_order_value=EXCLUDED.last_order_value,
        first_product=EXCLUDED.first_product, last_products=EXCLUDED.last_products,
        has_whatsapp_conversation=EXCLUDED.has_whatsapp_conversation, first_conversation_at=EXCLUDED.first_conversation_at,
        last_conversation_at=EXCLUDED.last_conversation_at, conversation_count=EXCLUDED.conversation_count,
        last_message_at=EXCLUDED.last_message_at, has_abandoned_cart=EXCLUDED.has_abandoned_cart,
        active_abandoned_carts_count=EXCLUDED.active_abandoned_carts_count, last_abandoned_cart_at=EXCLUDED.last_abandoned_cart_at,
        last_abandoned_cart_value=EXCLUDED.last_abandoned_cart_value, last_abandoned_cart_id=EXCLUDED.last_abandoned_cart_id,
        cart_recovered=EXCLUDED.cart_recovered, recovered_at=EXCLUDED.recovered_at, first_contact_at=EXCLUDED.first_contact_at,
        contacted_before_purchase=EXCLUDED.contacted_before_purchase, time_to_conversion_seconds=EXCLUDED.time_to_conversion_seconds,
        conversion_order_id=EXCLUDED.conversion_order_id, conversion_conversation_id=EXCLUDED.conversion_conversation_id,
        lifecycle=EXCLUDED.lifecycle, computed_at=NOW()`,
    [customerId, userId, m.has_orders, m.orders_count, m.first_order_at, m.last_order_at,
      m.last_order_status_slug, m.total_order_value, m.avg_order_value, m.last_order_value,
      m.first_product, JSON.stringify(m.last_products || []), m.has_whatsapp_conversation, m.first_conversation_at,
      m.last_conversation_at, m.conversation_count, m.last_message_at, m.has_abandoned_cart,
      m.active_abandoned_carts_count, m.last_abandoned_cart_at, m.last_abandoned_cart_value,
      m.last_abandoned_cart_id, m.cart_recovered, m.recovered_at, m.first_contact_at,
      m.contacted_before_purchase, m.time_to_conversion_seconds, m.conversion_order_id,
      m.conversion_conversation_id, m.lifecycle],
  );
}

module.exports = {
  computeMetrics,
  isQualifiedPurchase,
  recomputeCustomer,
  upsertMetrics,
  DEFAULT_QUALIFIED_STATUSES,
};
