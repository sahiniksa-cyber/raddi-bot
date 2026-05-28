'use strict';

const express = require('express');
const crypto = require('crypto');
const {
  activateWithCode,
  confirmProviderPayment,
  getUserBillingState,
  handleMoyasarWebhookEvent,
  isAdminUser,
  updateAutoRenew,
} = require('../services/billing/billing-service');
const {
  buildCallbackUrl,
  fetchMoyasarPayment,
  isPaidPlatformAccessPayment,
  normalizeMoyasarPayment,
} = require('../services/billing/moyasar-client');
const db = require('../db/client');
const { computeEffectiveRemaining } = require('../services/billing/message-quota');

/**
 * Verify Moyasar webhook signature in constant time. Returns true on match.
 * Accepts both `x-moyasar-signature` and the generic `signature` header.
 */
function verifyMoyasarSignature(req, secret) {
  const sigHeader = req.headers['x-moyasar-signature'] || req.headers['signature'];
  if (!sigHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  const a = Buffer.from(String(sigHeader));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createBillingRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const settings = deps.billingSettings || {};

  // ---------------------------------------------------------------------------
  // POST /billing/moyasar/webhook
  //
  // IMPORTANT: This endpoint MUST be mounted BEFORE any CSRF / same-origin
  // middleware — Moyasar's servers cannot send our session cookie or our
  // CSRF token. Authentication is via HMAC-SHA256 of the raw request body
  // using MOYASAR_WEBHOOK_SECRET. The route uses express.raw() so we can
  // recompute that HMAC byte-for-byte before any JSON parse.
  //
  // If your server.js adds an origin-check middleware later, exempt
  // `/billing/moyasar/webhook` explicitly.
  // ---------------------------------------------------------------------------
  router.post(
    '/billing/moyasar/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res, next) => {
      try {
        const secret = process.env.MOYASAR_WEBHOOK_SECRET;
        if (!secret) {
          return res.status(503).json({ error: 'webhook_disabled' });
        }
        const sigHeader = req.headers['x-moyasar-signature'] || req.headers['signature'];
        if (!sigHeader) {
          return res.status(401).json({ error: 'no_signature' });
        }
        if (!verifyMoyasarSignature(req, secret)) {
          return res.status(401).json({ error: 'bad_signature' });
        }

        let event;
        try {
          event = JSON.parse(req.body.toString('utf8'));
        } catch (_) {
          return res.status(400).json({ error: 'bad_json' });
        }

        const result = await handleMoyasarWebhookEvent(event, String(sigHeader));
        return res.json({ ok: true, ...result });
      } catch (err) {
        return next(err);
      }
    },
  );

  router.get('/api/billing/state', requireAuth, async (req, res, next) => {
    try {
      const accessBypass = await isAdminUser(req.session.userId, settings);
      res.json({
        success: true,
        settings: {
          platformAccessPriceHalalas: settings.platformAccessPriceHalalas,
          messagePriceHalalas: settings.messagePriceHalalas,
          currency: settings.currency,
          moyasarEnabled: Boolean(settings.moyasar?.enabled),
          moyasarPublishableKey: settings.moyasar?.publishableKey || '',
          moyasarApplePayLabel: settings.moyasar?.applePayLabel || 'Jwab',
          callbackUrl: buildCallbackUrl(settings, req),
          userId: req.session.userId,
        },
        state: {
          ...(await getUserBillingState(req.session.userId, settings)),
          accessBypass,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/billing/activate-code', requireAuth, async (req, res, next) => {
    try {
      const result = await activateWithCode(req.session.userId, req.body?.code, settings);
      if (!result.activated) return res.status(400).json({ success: false, message: 'كود التفعيل غير صحيح' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/billing/auto-renew', requireAuth, async (req, res, next) => {
    try {
      await updateAutoRenew(req.session.userId, !!req.body?.enabled);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/billing/callback', requireAuth, async (req, res, next) => {
    try {
      const rawPayment = await fetchMoyasarPayment(req.query.id, settings);
      if (!isPaidPlatformAccessPayment(rawPayment, settings)) {
        return res.redirect('/billing?payment=failed');
      }

      const payment = normalizeMoyasarPayment(rawPayment);
      // Hard reject any callback whose Moyasar metadata is missing a user
      // id, or whose user id does not match the authenticated session.
      // Without this an attacker who knows another user's payment id could
      // hit /billing/callback?id=... and activate someone else's account.
      if (!payment.userId || payment.userId !== req.session.userId) {
        return res.status(403).send('forbidden: payment user mismatch');
      }

      await confirmProviderPayment(req.session.userId, payment, 'moyasar checkout');
      return res.redirect('/?payment=paid');
    } catch (err) {
      return next(err);
    }
  });

  router.get('/api/billing/messages', requireAuth, async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT messages_remaining, quota_expires_at, expire_resets_quota,
                last_topup_amount, last_topup_at
         FROM billing_accounts WHERE user_id = $1`,
        [req.session.userId],
      );
      const row = result.rows[0] || {};
      const remaining = computeEffectiveRemaining(row);
      const total = Number(row.last_topup_amount || 0);
      const used = Math.max(0, total - remaining);

      const expiresAt = row.quota_expires_at ? new Date(row.quota_expires_at) : null;
      const expired = !!row.expire_resets_quota && expiresAt && expiresAt < new Date();
      const daysLeft = expiresAt
        ? Math.max(0, Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)))
        : null;

      let status = 'empty';
      if (expired) status = 'expired';
      else if (remaining > 0) status = 'active';

      res.json({
        success: true,
        remaining,
        totalLastTopup: total,
        used,
        quotaExpiresAt: row.quota_expires_at || null,
        daysLeft,
        status,
        supportWhatsappPhone: settings.supportWhatsappPhone || process.env.SUPPORT_WHATSAPP_PHONE || '',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createBillingRoutes, verifyMoyasarSignature };
