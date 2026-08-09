'use strict';

const express = require('express');
const { verifySallaSignature } = require('../services/salla/salla-signature');
const defaultStores = require('../services/salla/salla-stores');
const defaultDb = require('../db/client');

/**
 * Salla Partner-app webhook receiver.
 *
 * Salla's "Easy Mode" pushes the merchant's OAuth tokens to us via the
 * `app.store.authorize` event when the app is installed — no OAuth redirect
 * needed. We verify the X-Salla-Signature HMAC, then persist the tokens so the
 * AI can later read the merchant's store data. Every event is also logged to
 * `salla_webhook_events` (a DB breadcrumb) so we can diagnose delivery without
 * Railway logs and, later, decide what the bot does with store events.
 *
 * The endpoint is inert until SALLA_WEBHOOK_SECRET is configured (→ 503), so
 * the feature ships dark until the merchant supplies the secret from the Salla
 * partner dashboard. All collaborators are dependency-injectable for tests.
 *
 * Docs: https://docs.salla.dev/421119m0
 */
function createSallaRoutes(deps = {}) {
  const env = deps.env || process.env;
  const stores = deps.sallaStores || defaultStores;
  const db = deps.database || defaultDb;
  const router = express.Router();

  const logEvent = (merchantId, event, sigOk, detail) =>
    db.query(
      `INSERT INTO salla_webhook_events (merchant_id, event, signature_ok, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [merchantId != null ? String(merchantId) : null, event || null, Boolean(sigOk), JSON.stringify(detail || {})],
    ).catch(() => {});

  // Raw body required for the HMAC signature (mirrors Instagram/Moyasar). This
  // path is registered in the server's RAW_BODY_PATHS so the global JSON parser
  // is skipped for it.
  router.post('/salla/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const ts = () => new Date().toISOString();
    const secret = env.SALLA_WEBHOOK_SECRET;
    if (!secret) {
      console.warn(`${ts()} [salla-webhook] SALLA_WEBHOOK_SECRET not set — rejecting`);
      return res.status(503).json({ error: 'salla_not_configured' });
    }

    const sig = req.headers['x-salla-signature'];
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const sigOk = verifySallaSignature(raw, sig, secret);
    if (!sigOk) {
      console.warn(`${ts()} [salla-webhook] bad signature (sigPresent=${Boolean(sig)}, bodyLen=${raw.length})`);
      logEvent(null, null, false, { sigPresent: Boolean(sig), bodyLen: raw.length });
      return res.sendStatus(401);
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      logEvent(null, 'parse_error', true, { message: e.message });
      return res.sendStatus(400);
    }

    const event = body.event;
    const merchantId = body.merchant != null ? body.merchant : (body.data && body.data.merchant);
    const data = body.data || {};

    try {
      if ((event === 'app.store.authorize' || event === 'app.installed') && data.access_token) {
        await stores.upsertStoreAuthorization(merchantId, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: toExpiryDate(data.expires),
          scope: data.scope,
          storeName: (data.store && data.store.name) || data.store_name || null,
        }, { database: db });
        console.log(`${ts()} [salla-webhook] token stored for merchant=${merchantId} via ${event}`);
        logEvent(merchantId, event, true, { stored: true, expires: data.expires || null });
      } else if (event === 'app.uninstalled') {
        await stores.markUninstalled(merchantId, { database: db });
        console.log(`${ts()} [salla-webhook] merchant=${merchantId} uninstalled`);
        logEvent(merchantId, event, true, { uninstalled: true });
      } else {
        // Not handled yet (order.created, product.updated, …). Logged so we can
        // decide what the bot does with them later, per the phase-2 plan.
        logEvent(merchantId, event, true, {});
      }
      return res.sendStatus(200);
    } catch (err) {
      console.error(`${ts()} [salla-webhook] processing failed for ${event}: ${err.message}`);
      logEvent(merchantId, event, true, { error: err.message });
      // 5xx so Salla retries — capturing the authorize token must not be lost to
      // a transient DB blip.
      return res.status(500).json({ error: 'salla_webhook_processing_failed' });
    }
  });

  return router;
}

// Salla sends token `expires` as a Unix timestamp in SECONDS. Convert to a Date;
// tolerate accidental millisecond values and reject non-numeric input.
function toExpiryDate(expires) {
  if (expires === null || expires === undefined || expires === '') return null;
  const n = Number(expires);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms);
}

module.exports = { createSallaRoutes, toExpiryDate };
