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
  return {
    userId: row.id || row.user_id,
    name: row.name || '',
    email: String(row.email || '').toLowerCase(),
    role: row.role || 'user',
    createdAt: row.created_at || null,
    accessStatus,
    accessActive: isActiveAccess(accessStatus),
    activationSource: row.activation_source || 'none',
    receivableHalalas: Number(row.receivable_halalas || 0),
    receivableSar: halalasToSar(row.receivable_halalas),
    messagePriceHalalas: Number(row.message_price_halalas || 0),
    messagePriceSar: halalasToSar(row.message_price_halalas),
    internalNote: row.internal_note || '',
    lastPaymentAt: row.last_payment_at || null,
    whatsappStatus: row.whatsapp_status || 'stopped',
    whatsappPhone: row.whatsapp_phone || '',
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
  return {
    accessStatus: normalizeAccessStatus(account.platform_access_status),
    accessActive: isActiveAccess(account.platform_access_status),
    activationSource: account.activation_source,
    receivableHalalas: Number(account.receivable_halalas || 0),
    messagePriceHalalas: Number(account.message_price_halalas || 0),
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

async function activateWithCode(userId, code, settings = {}) {
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
  suspendAccess,
  updateReceivable,
};
