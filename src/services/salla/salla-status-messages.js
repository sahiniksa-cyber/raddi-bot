'use strict';

/**
 * Ready-made WhatsApp messages per Salla order status. Each merchant can enable
 * a status and write a template; when an `order.status.updated` webhook arrives
 * the bot sends the rendered message to the customer.
 *
 * The standard Salla status set is presented with Arabic labels; merchant custom
 * statuses (unknown slugs) are still supported by slug. Templates support the
 * variables listed in TEMPLATE_VARIABLES.
 */

const db = require('../../db/client');

// Curated standard Salla order statuses (slug + Arabic label + dot color).
const SALLA_ORDER_STATUSES = Object.freeze([
  { slug: 'payment_pending', label: 'بانتظار الدفع', color: '#f59e0b' },
  { slug: 'waiting_for_payment_confirmation', label: 'بانتظار تأكيد الدفع', color: '#f59e0b' },
  { slug: 'under_review', label: 'قيد المراجعة', color: '#f59e0b' },
  { slug: 'in_progress', label: 'قيد التنفيذ', color: '#3b82f6' },
  { slug: 'completed', label: 'مكتمل', color: '#10b981' },
  { slug: 'delivering', label: 'قيد التوصيل', color: '#8b5cf6' },
  { slug: 'shipped', label: 'تم الشحن', color: '#8b5cf6' },
  { slug: 'delivered', label: 'تم التوصيل', color: '#10b981' },
  { slug: 'canceled', label: 'ملغي', color: '#ef4444' },
  { slug: 'payment_failed', label: 'فشل الدفع', color: '#ef4444' },
  { slug: 'restored', label: 'مسترجع', color: '#6b7280' },
]);

const TEMPLATE_VARIABLES = Object.freeze(['order_id', 'customer_name', 'order_status', 'store_name']);

const STATUS_LABEL = new Map(SALLA_ORDER_STATUSES.map((s) => [s.slug, s.label]));

// Replace {var} tokens; unknown/undefined vars become ''. Leaves other braces be.
function renderMessage(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

// Full editable list = the standard statuses merged with any saved rows (+ saved
// custom slugs not in the standard set).
async function listStatusMessages(userId, deps = {}) {
  const database = deps.database || db;
  const rows = (await database.query(
    'SELECT status_slug, enabled, message_text FROM salla_status_messages WHERE user_id = $1',
    [userId],
  )).rows;
  const saved = new Map(rows.map((r) => [r.status_slug, r]));
  const out = SALLA_ORDER_STATUSES.map((s) => {
    const r = saved.get(s.slug);
    return { slug: s.slug, label: s.label, color: s.color, enabled: r ? r.enabled : false, message: r ? r.message_text : '' };
  });
  for (const r of rows) {
    if (!STATUS_LABEL.has(r.status_slug)) {
      out.push({ slug: r.status_slug, label: r.status_slug, color: '#6b7280', enabled: r.enabled, message: r.message_text });
    }
  }
  return out;
}

async function upsertStatusMessage(userId, statusSlug, { enabled, message } = {}, deps = {}) {
  const database = deps.database || db;
  const slug = String(statusSlug || '').trim();
  if (!slug) throw new Error('status_slug_required');
  await database.query(
    `INSERT INTO salla_status_messages (user_id, status_slug, enabled, message_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, status_slug) DO UPDATE SET
       enabled = EXCLUDED.enabled, message_text = EXCLUDED.message_text, updated_at = NOW()`,
    [userId, slug, enabled === true, String(message || '').slice(0, 4000)],
  );
}

// The message to send for a status, or null when disabled/empty.
async function resolveForStatus(userId, statusSlug, deps = {}) {
  const database = deps.database || db;
  const r = await database.query(
    'SELECT enabled, message_text FROM salla_status_messages WHERE user_id = $1 AND status_slug = $2',
    [userId, statusSlug],
  );
  const row = r.rows[0];
  if (!row || !row.enabled) return null;
  const text = String(row.message_text || '').trim();
  return text || null;
}

module.exports = {
  SALLA_ORDER_STATUSES,
  TEMPLATE_VARIABLES,
  renderMessage,
  listStatusMessages,
  upsertStatusMessage,
  resolveForStatus,
};
