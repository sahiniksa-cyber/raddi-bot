'use strict';

function buildCallbackUrl(settings = {}, req = null) {
  const base = settings.appBaseUrl || (req ? `${req.protocol}://${req.get('host')}` : '');
  return `${String(base || '').replace(/\/+$/, '')}/billing/callback`;
}

function normalizeMoyasarPayment(payment = {}) {
  return {
    id: String(payment.id || ''),
    status: String(payment.status || ''),
    amount: Number(payment.amount || 0),
    currency: String(payment.currency || '').toUpperCase(),
    method: String(payment.source?.type || 'moyasar'),
    providerPaymentId: String(payment.id || ''),
    userId: String(payment.metadata?.user_id || payment.metadata?.userId || ''),
    raw: payment,
  };
}

function isPaidPlatformAccessPayment(payment = {}, settings = {}) {
  const normalized = normalizeMoyasarPayment(payment);
  return normalized.status === 'paid'
    && normalized.amount === Number(settings.platformAccessPriceHalalas || 0)
    && normalized.currency === String(settings.currency || 'SAR').toUpperCase();
}

async function fetchMoyasarPayment(paymentId, settings = {}) {
  if (!settings.moyasar?.secretKey) throw new Error('MOYASAR_SECRET_KEY is not configured');
  const id = String(paymentId || '').trim();
  if (!id) throw new Error('Missing payment id');

  const response = await fetch(`https://api.moyasar.com/v1/payments/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.moyasar.secretKey}:`).toString('base64')}`,
      Accept: 'application/json',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `Moyasar fetch failed (${response.status})`);
  }
  return body;
}

module.exports = {
  buildCallbackUrl,
  fetchMoyasarPayment,
  isPaidPlatformAccessPayment,
  normalizeMoyasarPayment,
};
