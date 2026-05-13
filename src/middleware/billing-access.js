'use strict';

const { getUserBillingState, isAdminUser } = require('../services/billing/billing-service');

function shouldEnableBillingGate(settings = {}) {
  return settings.accessGateEnabled !== false;
}

function shouldBypassBillingApiGate(path = '') {
  return [
    '/api/auth/',
    '/api/billing/',
    '/api/admin/',
  ].some(prefix => String(path || '').startsWith(prefix));
}

function createBillingAccessGate({ settings }) {
  return async function billingAccessGate(req, res, next) {
    try {
      if (!shouldEnableBillingGate(settings)) return next();
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

function createBillingApiGate({ settings }) {
  return async function billingApiGate(req, res, next) {
    try {
      if (!shouldEnableBillingGate(settings)) return next();
      if (shouldBypassBillingApiGate(req.path)) return next();
      if (!req.session?.userId) return next();
      if (await isAdminUser(req.session.userId, settings)) return next();

      const state = await getUserBillingState(req.session.userId, settings);
      if (state.accessActive) return next();
      return res.status(402).json({ success: false, message: 'يلزم تفعيل المنصة قبل الاستخدام', redirect: '/billing' });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  createBillingAccessGate,
  createBillingApiGate,
  shouldBypassBillingApiGate,
  shouldEnableBillingGate,
};
