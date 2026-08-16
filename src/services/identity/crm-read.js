'use strict';

/**
 * CRM read services for the dashboard: paginated customer list (with segment
 * rules + free-text search), live segment counts, unified search, and the
 * Customer-360 detail (profile + metrics + orders + carts + timeline +
 * identities). All queries are scoped by `user_id` (merchant) and use the
 * injection-safe rule compiler for any user-supplied filter.
 */

const db = require('../../db/client');
const { compileRules } = require('./segment-rules');
const { canonicalDigits } = require('./phone');

const LIST_COLUMNS = `c.id, c.canonical_phone, c.display_name, c.email, c.salla_customer_id,
  m.orders_count, m.total_order_value, m.has_orders, m.has_whatsapp_conversation,
  m.has_abandoned_cart, m.cart_recovered, m.lifecycle, m.last_order_at, m.last_message_at`;

function buildWhere(userId, rules, search) {
  const where = ['c.user_id = $1'];
  const params = [userId];
  if (rules) {
    const c = compileRules(rules, { startIndex: params.length + 1 });
    if (c.sql && c.sql !== 'TRUE') { where.push(c.sql); params.push(...c.params); }
  }
  if (search && String(search).trim()) {
    const p = params.length + 1;
    params.push('%' + String(search).trim() + '%');
    where.push(`(c.display_name ILIKE $${p} OR c.canonical_phone ILIKE $${p} OR c.email ILIKE $${p})`);
  }
  return { whereSql: where.join(' AND '), params };
}

async function listCustomers(userId, { rules, page = 1, pageSize = 50, search } = {}, deps = {}) {
  const database = deps.database || db;
  const { whereSql, params } = buildWhere(userId, rules, search);
  const size = Math.min(Math.max(1, pageSize), 200);
  const offset = (Math.max(1, page) - 1) * size;
  const sql = `SELECT ${LIST_COLUMNS}
     FROM crm_customers c LEFT JOIN crm_customer_metrics m ON m.customer_id = c.id
     WHERE ${whereSql}
     ORDER BY COALESCE(m.last_message_at, m.last_order_at, c.created_at) DESC NULLS LAST
     LIMIT ${size} OFFSET ${offset}`;
  const r = await database.query(sql, params);
  return { customers: r.rows, page: Math.max(1, page), pageSize: size };
}

async function countSegment(userId, rules, deps = {}) {
  const database = deps.database || db;
  const { whereSql, params } = buildWhere(userId, rules, null);
  const sql = `SELECT COUNT(*)::int AS n
     FROM crm_customers c LEFT JOIN crm_customer_metrics m ON m.customer_id = c.id
     WHERE ${whereSql}`;
  const r = await database.query(sql, params);
  return r.rows[0] ? r.rows[0].n : 0;
}

async function searchCustomers(userId, q, deps = {}) {
  const database = deps.database || db;
  const raw = String(q || '').trim();
  if (!raw) return [];
  const canonical = canonicalDigits(raw) || '';
  const r = await database.query(
    `SELECT DISTINCT c.id, c.display_name, c.canonical_phone, c.email, c.salla_customer_id
       FROM crm_customers c
       LEFT JOIN crm_orders o ON o.customer_id = c.id
      WHERE c.user_id = $1 AND (
            c.display_name ILIKE $2 OR c.email ILIKE $2
         OR ($3 <> '' AND c.canonical_phone = $3)
         OR c.salla_customer_id = $4 OR o.salla_order_id = $4 OR o.reference_id = $4)
      LIMIT 50`,
    [userId, '%' + raw + '%', canonical, raw],
  );
  return r.rows;
}

async function getCustomer360(userId, customerId, deps = {}) {
  const database = deps.database || db;
  const customer = (await database.query(
    'SELECT * FROM crm_customers WHERE user_id = $1 AND id = $2', [userId, customerId],
  )).rows[0];
  if (!customer) return null;

  const [metrics, orders, carts, timeline, identities] = await Promise.all([
    database.query('SELECT * FROM crm_customer_metrics WHERE customer_id = $1', [customerId]),
    database.query(
      `SELECT salla_order_id, reference_id, status_slug, is_qualified_purchase, total_amount, currency, coupon_code, placed_at
         FROM crm_orders WHERE user_id = $1 AND customer_id = $2 ORDER BY placed_at DESC NULLS LAST LIMIT 100`,
      [userId, customerId]),
    database.query(
      `SELECT salla_cart_id, status, total_amount, currency, abandoned_at, converted_at
         FROM crm_carts WHERE user_id = $1 AND customer_id = $2 ORDER BY abandoned_at DESC NULLS LAST LIMIT 100`,
      [userId, customerId]),
    database.query(
      `SELECT event_type, occurred_at, source, ref_type, ref_id, detail
         FROM crm_timeline_events WHERE user_id = $1 AND customer_id = $2 ORDER BY occurred_at DESC LIMIT 200`,
      [userId, customerId]),
    database.query('SELECT identity_type, identity_value FROM crm_identities WHERE customer_id = $1', [customerId]),
  ]);

  return {
    customer,
    metrics: metrics.rows[0] || null,
    orders: orders.rows,
    carts: carts.rows,
    timeline: timeline.rows,
    identities: identities.rows,
  };
}

module.exports = { listCustomers, countSegment, searchCustomers, getCustomer360, buildWhere };
