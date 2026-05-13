'use strict';

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSecretPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  if (withSlash === '/' || withSlash.startsWith('/api/') || withSlash.includes('..')) return null;
  if (!/^\/[A-Za-z0-9/_-]+$/.test(withSlash)) return null;
  return withSlash.replace(/\/+$/, '') || null;
}

function parseAdminEmails(value) {
  return String(value || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function parseActivationCodes(value) {
  return String(value || '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.origin;
  } catch (_) {
    return '';
  }
}

function getBillingSettings(env = process.env) {
  const publishableKey = String(env.MOYASAR_PUBLISHABLE_KEY || '').trim();
  const secretKey = String(env.MOYASAR_SECRET_KEY || '').trim();
  return {
    adminSecretPath: normalizeSecretPath(env.ADMIN_SECRET_PATH) || '/owner-control',
    adminEmails: parseAdminEmails(env.ADMIN_EMAILS),
    platformAccessPriceHalalas: parsePositiveInt(env.PLATFORM_ACCESS_PRICE_HALALAS, 175000),
    messagePriceHalalas: parsePositiveInt(env.MESSAGE_PRICE_HALALAS, 0),
    currency: String(env.BILLING_CURRENCY || 'SAR').trim().toUpperCase() || 'SAR',
    accessGateEnabled: String(env.BILLING_ACCESS_GATE_ENABLED || 'true').toLowerCase() !== 'false',
    activationCodes: parseActivationCodes(env.ADMIN_ACTIVATION_CODES),
    appBaseUrl: normalizeBaseUrl(env.APP_BASE_URL),
    moyasar: {
      enabled: Boolean(publishableKey && secretKey),
      publishableKey,
      secretKey,
      webhookSecret: String(env.MOYASAR_WEBHOOK_SECRET || '').trim(),
      applePayLabel: String(env.MOYASAR_APPLE_PAY_LABEL || 'Raddi').trim() || 'Raddi',
    },
  };
}

module.exports = {
  getBillingSettings,
  normalizeBaseUrl,
  normalizeSecretPath,
  parseActivationCodes,
  parseAdminEmails,
};
