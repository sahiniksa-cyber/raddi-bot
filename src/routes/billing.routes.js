'use strict';

const express = require('express');
const { activateWithCode, getUserBillingState } = require('../services/billing/billing-service');

function createBillingRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const settings = deps.billingSettings || {};

  router.get('/api/billing/state', requireAuth, async (req, res, next) => {
    try {
      res.json({
        success: true,
        settings: {
          platformAccessPriceHalalas: settings.platformAccessPriceHalalas,
          messagePriceHalalas: settings.messagePriceHalalas,
          currency: settings.currency,
        },
        state: await getUserBillingState(req.session.userId, settings),
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

  return router;
}

module.exports = { createBillingRoutes };
