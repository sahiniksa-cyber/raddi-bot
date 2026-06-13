'use strict';

const realDb = require('../../db/client');

// Records a powerful admin action against a merchant in admin_audit_log.
// CRITICAL: auditing must NEVER break the action it records — on any DB error
// we log a warning and return { logged: false } instead of throwing.
async function logAdminAction(
  { adminUserId = null, action, targetUserId = null, detail = {}, result = 'ok' } = {},
  { db = realDb } = {},
) {
  if (!action || !String(action).trim()) throw new Error('action required');
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, detail, result)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        adminUserId || null,
        String(action).trim(),
        targetUserId || null,
        JSON.stringify(detail || {}),
        String(result || 'ok'),
      ],
    );
    return { logged: true };
  } catch (err) {
    try { console.warn(`[admin-audit] failed to record "${action}": ${err.message}`); } catch (_) {}
    return { logged: false, error: err.message };
  }
}

async function listAdminAuditLog({ targetUserId = null, limit = 50 } = {}, { db = realDb } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  if (targetUserId) {
    const res = await db.query(
      `SELECT id, admin_user_id, action, target_user_id, detail, result, created_at
       FROM admin_audit_log WHERE target_user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [targetUserId, lim],
    );
    return res.rows;
  }
  const res = await db.query(
    `SELECT id, admin_user_id, action, target_user_id, detail, result, created_at
     FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
    [lim],
  );
  return res.rows;
}

module.exports = { logAdminAction, listAdminAuditLog };
