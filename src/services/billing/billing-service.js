'use strict';

const db = require('../../db/client');
const { appendLedgerRow } = require('./excel-ledger');

const ACTIVE_STATUSES = new Set(['active', 'free']);
const KNOWN_STATUSES = new Set(['unpaid', 'active', 'free', 'suspended']);

function normalizeAccessStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return KNOWN_STATUSES.has(normalized) ? normalized : 'unpaid';
}

function isActiveAccess(status) {
  return ACTIVE_STATUSES.has(normalizeAccessStatus(status));
}

function halalasToSar(value) {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return (amount / 100).toFixed(2);
}

function buildAdminCustomerRow(row = {}) {
  const accessStatus = normalizeAccessStatus(row.platform_access_status);
  let accessActive = isActiveAccess(accessStatus);

  // Check expiry
  const accessExpiresAt = row.access_expires_at || null;
  if (accessActive && accessExpiresAt) {
    const expiresAt = new Date(accessExpiresAt);
    if (expiresAt <= new Date()) {
      accessActive = false;
    }
  }

  // Calculate remaining days
  let remainingDays = null;
  if (accessExpiresAt) {
    const diff = new Date(accessExpiresAt) - new Date();
    remainingDays = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return {
    userId: row.id || row.user_id,
    name: row.name || '',
    email: String(row.email || '').toLowerCase(),
    role: row.role || 'user',
    createdAt: row.created_at || null,
    accessStatus,
    accessActive,
    activationSource: row.activation_source || 'none',
    receivableHalalas: Number(row.receivable_halalas || 0),
    receivableSar: halalasToSar(row.receivable_halalas),
    messagePriceHalalas: Number(row.message_price_halalas || 0),
    messagePriceSar: halalasToSar(row.message_price_halalas),
    internalNote: row.internal_note || '',
    lastPaymentAt: row.last_payment_at || null,
    whatsappStatus: row.whatsapp_status || 'stopped',
    whatsappPhone: row.whatsapp_phone || '',
    accessExpiresAt,
    remainingDays,
    messagesRemaining: Number(row.messages_remaining || 0),
    quotaExpiresAt: row.quota_expires_at || null,
    expireResetsQuota: row.expire_resets_quota !== false,
    lastTopupAmount: Number(row.last_topup_amount || 0),
    lastTopupAt: row.last_topup_at || null,
    effectiveRemaining: (() => {
      const remaining = Number(row.messages_remaining || 0);
      if (remaining <= 0) return 0;
      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = row.expire_resets_quota !== false && expiresAt && expiresAt < new Date();
      return expired ? 0 : remaining;
    })(),
    quotaStatus: (() => {
      const remaining = Number(row.messages_remaining || 0);
      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = row.expire_resets_quota !== false && expiresAt && expiresAt < new Date();
      if (expired) return 'expired';
      if (remaining > 0) return 'active';
      if (!row.last_topup_at) return 'never_topped_up';
      return 'empty';
    })(),
    quotaDaysLeft: (() => {
      if (!row.quota_expires_at) return null;
      const diff = new Date(row.quota_expires_at) - new Date();
      return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    })(),
  };
}

function isValidActivationCode(code, settings = {}) {
  const normalized = String(code || '').trim();
  if (!normalized) return false;
  return (settings.activationCodes || []).includes(normalized);
}

function paymentAlreadyUsedByAnotherUser(existingPayment, userId) {
  if (!existingPayment) return false;
  return String(existingPayment.user_id || '') !== String(userId || '');
}

async function isAdminUser(userId, settings = {}) {
  if (!userId) return false;
  const result = await db.query('SELECT email, role FROM users WHERE id = $1 LIMIT 1', [userId]);
  const user = result.rows[0];
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (settings.adminEmails || []).includes(String(user.email || '').toLowerCase());
}

async function ensureBillingAccount(userId, settings = {}) {
  const result = await db.query(
    `INSERT INTO billing_accounts (user_id, message_price_halalas)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET message_price_halalas = COALESCE(billing_accounts.message_price_halalas, EXCLUDED.message_price_halalas)
     RETURNING *`,
    [userId, settings.messagePriceHalalas || 0],
  );
  return result.rows[0];
}

async function getUserBillingState(userId, settings = {}) {
  const account = await ensureBillingAccount(userId, settings);
  let accessActive = isActiveAccess(account.platform_access_status);

  // Check if access has expired
  if (accessActive && account.access_expires_at) {
    const expiresAt = new Date(account.access_expires_at);
    if (expiresAt <= new Date()) {
      accessActive = false;
    }
  }

  return {
    accessStatus: normalizeAccessStatus(account.platform_access_status),
    accessActive,
    activationSource: account.activation_source,
    receivableHalalas: Number(account.receivable_halalas || 0),
    messagePriceHalalas: Number(account.message_price_halalas || 0),
    autoRenewEnabled: !!account.auto_renew_enabled,
    accessExpiresAt: account.access_expires_at || null,
  };
}

async function listAdminCustomers() {
  const result = await db.query(
    `SELECT
       u.id, u.name, u.email, u.role, u.created_at,
       COALESCE(ba.platform_access_status, 'unpaid') AS platform_access_status,
       COALESCE(ba.activation_source, 'none') AS activation_source,
       COALESCE(ba.receivable_halalas, 0) AS receivable_halalas,
       COALESCE(ba.message_price_halalas, 0) AS message_price_halalas,
       COALESCE(ba.internal_note, '') AS internal_note,
       ba.last_payment_at,
       ba.access_expires_at,
       ba.messages_remaining,
       ba.quota_expires_at,
       ba.expire_resets_quota,
       ba.last_topup_amount,
       ba.last_topup_at,
       COALESCE(ws.status, 'stopped') AS whatsapp_status,
       COALESCE(ws.phone, '') AS whatsapp_phone
     FROM users u
     LEFT JOIN billing_accounts ba ON ba.user_id = u.id
     LEFT JOIN whatsapp_sessions ws ON ws.user_id = u.id
     ORDER BY u.created_at DESC`,
  );
  return result.rows.map(buildAdminCustomerRow);
}

async function recordBillingEvent(userId, eventType, payload = {}) {
  await db.query(
    'INSERT INTO billing_events (user_id, event_type, payload) VALUES ($1, $2, $3::jsonb)',
    [userId || null, eventType, JSON.stringify(payload)],
  );
}

async function loadLedgerUser(userId) {
  const result = await db.query('SELECT name, email FROM users WHERE id = $1 LIMIT 1', [userId]);
  return result.rows[0] || {};
}

async function appendLedgerSafe(userId, record) {
  try {
    const file = await appendLedgerRow({
      ...record,
      user: await loadLedgerUser(userId),
    });
    await recordBillingEvent(userId, 'excel_ledger_written', { file, status: record.status });
  } catch (err) {
    await recordBillingEvent(userId, 'excel_ledger_failed', { error: err.message, status: record.status });
  }
}

async function setAccess(userId, status, source, note = '') {
  const accessStatus = normalizeAccessStatus(status);
  const activatedAt = isActiveAccess(accessStatus) ? new Date() : null;
  const suspendedAt = accessStatus === 'suspended' ? new Date() : null;
  const result = await db.query(
    `INSERT INTO billing_accounts (
       user_id, platform_access_status, activation_source, access_activated_at, access_suspended_at, internal_note
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       platform_access_status = EXCLUDED.platform_access_status,
       activation_source = EXCLUDED.activation_source,
       access_activated_at = COALESCE(EXCLUDED.access_activated_at, billing_accounts.access_activated_at),
       access_suspended_at = EXCLUDED.access_suspended_at,
       internal_note = CASE WHEN EXCLUDED.internal_note = '' THEN billing_accounts.internal_note ELSE EXCLUDED.internal_note END
     RETURNING *`,
    [userId, accessStatus, source, activatedAt, suspendedAt, note],
  );
  await recordBillingEvent(userId, `access_${accessStatus}`, { source, note });
  return result.rows[0];
}

async function grantFreeAccess(userId, note = '') {
  const account = await setAccess(userId, 'free', 'free_code', note);
  await db.query(
    `INSERT INTO billing_payments (user_id, amount_halalas, currency, status, method, activation_type, raw_payload)
     VALUES ($1, 0, 'SAR', 'free_activated', 'admin', 'free_code', $2::jsonb)`,
    [userId, JSON.stringify({ note })],
  );
  await appendLedgerSafe(userId, {
    amountHalalas: 0,
    currency: 'SAR',
    method: 'admin',
    status: 'free_activated',
    activationType: 'free_code',
    note,
  });
  return account;
}

async function markPaidAccess(userId, amountHalalas, note = '') {
  const amount = Math.max(0, parseInt(amountHalalas, 10) || 0);
  const account = await setAccess(userId, 'active', 'paid', note);
  await db.query(
    `INSERT INTO billing_payments (user_id, amount_halalas, currency, status, method, activation_type, raw_payload)
     VALUES ($1, $2, 'SAR', 'paid', 'admin', 'paid', $3::jsonb)`,
    [userId, amount, JSON.stringify({ note, manual: true })],
  );
  await db.query('UPDATE billing_accounts SET last_payment_at = NOW() WHERE user_id = $1', [userId]);
  await appendLedgerSafe(userId, {
    amountHalalas: amount,
    currency: 'SAR',
    method: 'admin',
    status: 'paid',
    activationType: 'paid',
    note,
  });
  return account;
}

async function confirmProviderPayment(userId, payment, note = '') {
  const providerPaymentId = String(payment.providerPaymentId || payment.id || '').trim();
  if (!providerPaymentId) throw new Error('Missing provider payment id');

  const existing = await db.query(
    'SELECT user_id FROM billing_payments WHERE provider = $1 AND provider_payment_id = $2 LIMIT 1',
    ['moyasar', providerPaymentId],
  );
  if (paymentAlreadyUsedByAnotherUser(existing.rows[0], userId)) {
    throw new Error('Payment was already used by another account');
  }

  const account = await setAccess(userId, 'active', 'paid', note || 'moyasar');
  await db.query(
    `INSERT INTO billing_payments (
       user_id, provider, provider_payment_id, amount_halalas, currency, status, method, activation_type, raw_payload
     )
     VALUES ($1, 'moyasar', $2, $3, $4, $5, $6, 'paid', $7::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      userId,
      providerPaymentId,
      payment.amount,
      payment.currency,
      payment.status,
      payment.method,
      JSON.stringify(payment.raw || payment),
    ],
  );
  await db.query('UPDATE billing_accounts SET last_payment_at = NOW() WHERE user_id = $1', [userId]);
  await appendLedgerSafe(userId, {
    amountHalalas: payment.amount,
    currency: payment.currency,
    method: payment.method,
    providerPaymentId,
    status: payment.status,
    activationType: 'paid',
    note: note || 'moyasar',
  });
  return account;
}

async function suspendAccess(userId, note = '') {
  return setAccess(userId, 'suspended', 'admin_suspended', note);
}

async function reactivateAccess(userId, note = '') {
  return setAccess(userId, 'active', 'admin_reactivated', note);
}

async function updateReceivable(userId, receivableHalalas, note = '') {
  const amount = Math.max(0, parseInt(receivableHalalas, 10) || 0);
  const result = await db.query(
    `INSERT INTO billing_accounts (user_id, receivable_halalas, internal_note)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       receivable_halalas = EXCLUDED.receivable_halalas,
       internal_note = CASE WHEN EXCLUDED.internal_note = '' THEN billing_accounts.internal_note ELSE EXCLUDED.internal_note END
     RETURNING *`,
    [userId, amount, note],
  );
  await recordBillingEvent(userId, 'receivable_updated', { amountHalalas: amount, note });
  return result.rows[0];
}

async function updateAutoRenew(userId, enabled) {
  const result = await db.query(
    `INSERT INTO billing_accounts (user_id, auto_renew_enabled)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET auto_renew_enabled = EXCLUDED.auto_renew_enabled
     RETURNING *`,
    [userId, !!enabled],
  );
  await recordBillingEvent(userId, 'auto_renew_updated', { enabled: !!enabled });
  return result.rows[0];
}

async function setAccessExpiry(userId, days, note = '') {
  const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const result = await db.query(
    `INSERT INTO billing_accounts (user_id, access_expires_at, internal_note)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       access_expires_at = EXCLUDED.access_expires_at,
       internal_note = CASE WHEN EXCLUDED.internal_note = '' THEN billing_accounts.internal_note ELSE EXCLUDED.internal_note END
     RETURNING *`,
    [userId, expiresAt, note],
  );
  await recordBillingEvent(userId, 'access_expiry_set', { days, expiresAt, note });
  return result.rows[0];
}

async function redeemCoupon(userId, code) {
  const result = await db.query(
    `SELECT * FROM coupons WHERE code = $1 AND active = TRUE LIMIT 1`,
    [String(code || '').trim()],
  );
  const coupon = result.rows[0];
  if (!coupon) return { redeemed: false };
  if (coupon.uses_count >= coupon.max_uses) return { redeemed: false };

  // Increment uses
  await db.query('UPDATE coupons SET uses_count = uses_count + 1 WHERE id = $1', [coupon.id]);

  // Grant access based on type
  if (coupon.type === 'free_activation' || coupon.type === 'discount_percent') {
    await grantFreeAccess(userId, `coupon:${coupon.code}`);
  }

  await recordBillingEvent(userId, 'coupon_redeemed', { couponId: coupon.id, code: coupon.code, type: coupon.type });
  return { redeemed: true, type: coupon.type };
}

async function activateWithCode(userId, code, settings = {}) {
  // First check coupons table
  const couponResult = await redeemCoupon(userId, code);
  if (couponResult.redeemed) return { activated: true };

  // Fall back to static activation codes
  if (!isValidActivationCode(code, settings)) return { activated: false };
  await grantFreeAccess(userId, 'activation code');
  return { activated: true };
}

module.exports = {
  activateWithCode,
  buildAdminCustomerRow,
  confirmProviderPayment,
  getUserBillingState,
  grantFreeAccess,
  halalasToSar,
  isActiveAccess,
  isAdminUser,
  isValidActivationCode,
  listAdminCustomers,
  markPaidAccess,
  normalizeAccessStatus,
  paymentAlreadyUsedByAnotherUser,
  reactivateAccess,
  redeemCoupon,
  setAccess,
  setAccessExpiry,
  suspendAccess,
  updateAutoRenew,
  updateReceivable,
};
