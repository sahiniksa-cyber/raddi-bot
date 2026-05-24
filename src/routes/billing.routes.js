'use strict';

const express = require('express');
const {
  activateWithCode,
  confirmProviderPayment,
  getUserBillingState,
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

function createBillingRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const settings = deps.billingSettings || {};

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
      if (payment.userId && payment.userId !== req.session.userId) {
        return res.redirect('/billing?payment=mismatch');
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

module.exports = { createBillingRoutes };
