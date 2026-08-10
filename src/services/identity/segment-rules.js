'use strict';

/**
 * Segment rule engine — compiles a rules JSON (AND/OR groups of predicates over
 * a customer's derived metrics) into a parameterized SQL WHERE fragment that
 * runs against `crm_customers c JOIN crm_customer_metrics m`. This powers both
 * saved segments and the campaign audience builder.
 *
 * SECURITY: field and operator names are whitelisted → the only thing that ever
 * reaches SQL from user input is a bound parameter ($n) or a fixed expression
 * from the tables below. Unknown field/operator/segment throws. Never string-
 * interpolate a value.
 *
 * Segments (§8-14, §24) are DERIVED from the metric columns (no redundant
 * storage), so they double as a virtual `segment` field and as quick lists.
 */

// Whitelisted filterable fields → their SQL expression + value type.
const FIELD_DEFS = Object.freeze({
  orders_count: { expr: 'm.orders_count', type: 'number' },
  total_order_value: { expr: 'm.total_order_value', type: 'number' },
  avg_order_value: { expr: 'm.avg_order_value', type: 'number' },
  last_order_value: { expr: 'm.last_order_value', type: 'number' },
  conversation_count: { expr: 'm.conversation_count', type: 'number' },
  active_abandoned_carts_count: { expr: 'm.active_abandoned_carts_count', type: 'number' },
  has_orders: { expr: 'm.has_orders', type: 'bool' },
  has_whatsapp_conversation: { expr: 'm.has_whatsapp_conversation', type: 'bool' },
  has_abandoned_cart: { expr: 'm.has_abandoned_cart', type: 'bool' },
  cart_recovered: { expr: 'm.cart_recovered', type: 'bool' },
  contacted_before_purchase: { expr: 'COALESCE(m.contacted_before_purchase, false)', type: 'bool' },
  lifecycle: { expr: 'm.lifecycle', type: 'text' },
  last_order_status_slug: { expr: 'm.last_order_status_slug', type: 'text' },
  first_product: { expr: 'm.first_product', type: 'text' },
  last_order_at: { expr: 'm.last_order_at', type: 'date' },
  first_order_at: { expr: 'm.first_order_at', type: 'date' },
  last_message_at: { expr: 'm.last_message_at', type: 'date' },
  first_contact_at: { expr: 'm.first_contact_at', type: 'date' },
});

// Derived segment predicates (over the metric columns). Also the quick lists.
const SEGMENT_SQL = Object.freeze({
  all: 'TRUE',
  buyers: '(m.has_orders)',
  non_buyers: '(m.has_orders = false)',
  asked_not_ordered: '(m.has_whatsapp_conversation AND m.orders_count = 0)',
  asked_then_ordered: '(COALESCE(m.contacted_before_purchase, false) = true)',
  ordered_then_contacted: '(m.has_orders AND m.has_whatsapp_conversation AND COALESCE(m.contacted_before_purchase, false) = false)',
  ordered_no_contact: '(m.has_orders AND m.has_whatsapp_conversation = false)',
  cart_abandoned_no_purchase: '(m.has_abandoned_cart AND m.orders_count = 0)',
  cart_recovered_then_purchased: '(m.cart_recovered)',
  repeat_customer: '(m.orders_count >= 2)',
  new_customers: '(m.orders_count = 1)',
});

// Ready-made lists surfaced in the UI (§24).
const QUICK_SEGMENTS = Object.freeze([
  { key: 'all', name: 'كل العملاء', rules: { segment: 'all' } },
  { key: 'buyers', name: 'اشتروا', rules: { segment: 'buyers' } },
  { key: 'non_buyers', name: 'لم يشتروا', rules: { segment: 'non_buyers' } },
  { key: 'asked_not_ordered', name: 'سألوا ولم يطلبوا', rules: { segment: 'asked_not_ordered' } },
  { key: 'asked_then_ordered', name: 'سألوا ثم اشتروا', rules: { segment: 'asked_then_ordered' } },
  { key: 'ordered_then_contacted', name: 'اشتروا ثم تواصلوا', rules: { segment: 'ordered_then_contacted' } },
  { key: 'ordered_no_contact', name: 'طلبوا بدون تواصل', rules: { segment: 'ordered_no_contact' } },
  { key: 'cart_abandoned_no_purchase', name: 'سلات متروكة', rules: { segment: 'cart_abandoned_no_purchase' } },
  { key: 'cart_recovered_then_purchased', name: 'سلات مسترجعة', rules: { segment: 'cart_recovered_then_purchased' } },
  { key: 'new_customers', name: 'عملاء جدد', rules: { segment: 'new_customers' } },
  { key: 'repeat_customer', name: 'عملاء متكررون', rules: { segment: 'repeat_customer' } },
]);

const NUM_OPS = Object.freeze({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' });

function coerce(type, value) {
  if (type === 'number') { const n = Number(value); if (!Number.isFinite(n)) throw new Error('bad_number_value'); return n; }
  return value;
}

function compileRules(rules, { startIndex = 1 } = {}) {
  const params = [];
  // Placeholders are numbered from startIndex so the fragment can be spliced
  // after other bound params (e.g. $1 = user_id) in a larger query.
  const push = (v) => { params.push(v); return '$' + (startIndex + params.length - 1); };

  function leaf(node) {
    if (node.segment !== undefined) {
      const sql = SEGMENT_SQL[node.segment];
      if (!sql) throw new Error('unknown_segment:' + node.segment);
      return sql;
    }
    const def = FIELD_DEFS[node.field];
    if (!def) throw new Error('unknown_field:' + node.field);
    const op = node.operator;

    if (def.type === 'bool') {
      if (op && op !== 'is' && op !== 'eq') throw new Error('unknown_operator:' + op);
      const val = node.value === true || node.value === 'true';
      return `${def.expr} IS ${val ? 'TRUE' : 'FALSE'}`;
    }
    if (op === 'in') {
      if (!Array.isArray(node.value)) throw new Error('in_requires_array');
      return `${def.expr} = ANY(${push(node.value)})`;
    }
    if (def.type === 'date') {
      if (op === 'within_days') return `${def.expr} >= NOW() - (${push(Number(node.value) || 0)} * INTERVAL '1 day')`;
      if (op === 'before' || op === 'lt') return `${def.expr} < ${push(node.value)}`;
      if (op === 'after' || op === 'gt') return `${def.expr} > ${push(node.value)}`;
      throw new Error('unknown_operator:' + op);
    }
    // number / text
    if (op === 'eq') return `${def.expr} = ${push(coerce(def.type, node.value))}`;
    if (op === 'ne') return `${def.expr} <> ${push(coerce(def.type, node.value))}`;
    const sqlOp = NUM_OPS[op];
    if (!sqlOp || def.type === 'text') {
      if (def.type === 'text') throw new Error('unknown_operator:' + op);
      throw new Error('unknown_operator:' + op);
    }
    return `${def.expr} ${sqlOp} ${push(coerce(def.type, node.value))}`;
  }

  function build(node) {
    if (!node || typeof node !== 'object') return 'TRUE';
    if (Array.isArray(node.conditions)) {
      const op = String(node.op || 'and').toUpperCase() === 'OR' ? 'OR' : 'AND';
      const parts = node.conditions.map(build).filter((p) => p && p !== 'TRUE');
      if (!parts.length) return 'TRUE';
      return '(' + parts.join(` ${op} `) + ')';
    }
    if (node.field !== undefined || node.segment !== undefined) return leaf(node);
    return 'TRUE';
  }

  return { sql: build(rules), params };
}

module.exports = { compileRules, FIELD_DEFS, SEGMENT_SQL, QUICK_SEGMENTS };
