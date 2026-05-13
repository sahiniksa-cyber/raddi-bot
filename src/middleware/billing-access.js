'use strict';

const { getUserBillingState, isAdminUser } = require('../services/billing/billing-service');

function createBillingAccessGate({ settings }) {
  return async function billingAccessGate(req, res, next) {
    try {
      if (!settings?.accessGateEnabled) return next();
      if (!req.session?.userId) return next();
      if (await isAdminUser(req.session.userId, settings)) return next();

      const state = await getUserBillingState(req.session.userId, settings);
      if (state.accessActive) return next();
      return res.redirect('/billing');
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createBillingAccessGate };
