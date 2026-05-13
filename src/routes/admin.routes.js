'use strict';

const path = require('path');
const express = require('express');

const {
  grantFreeAccess,
  isAdminUser,
  listAdminCustomers,
  markPaidAccess,
  reactivateAccess,
  suspendAccess,
  updateReceivable,
} = require('../services/billing/billing-service');

function canOpenAdminConsole({ path: requestPath, user, settings }) {
  if (!settings?.adminSecretPath || requestPath !== settings.adminSecretPath) return false;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (settings.adminEmails || []).includes(String(user.email || '').toLowerCase());
}

function createAdminRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const dashboardDir = deps.dashboardDir || path.join(process.cwd(), 'dashboard');
  const settings = deps.billingSettings || {};

  async function requireOwner(req, res, next) {
    try {
      if (!req.session?.userId) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, message: 'غير مصرح' });
        return res.redirect('/login');
      }
      if (!(await isAdminUser(req.session.userId, settings))) {
        return req.path.startsWith('/api/')
          ? res.status(403).json({ success: false, message: 'غير مصرح' })
          : res.status(404).send('Not found');
      }
      return next();
    } catch (err) {
      return next(err);
    }
  }

  router.get(settings.adminSecretPath, requireAuth, requireOwner, (req, res) => {
    res.sendFile(path.join(dashboardDir, 'admin.html'));
  });

  router.get('/api/admin/customers', requireAuth, requireOwner, async (req, res, next) => {
    try {
      res.json({ success: true, customers: await listAdminCustomers() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/admin/customers/:userId/action', requireAuth, requireOwner, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const action = String(req.body?.action || '').trim();
      const note = String(req.body?.note || '').trim();
      const amountHalalas = parseInt(req.body?.amountHalalas, 10) || 0;

      if (action === 'grant_free') await grantFreeAccess(userId, note);
      else if (action === 'mark_paid') await markPaidAccess(userId, amountHalalas || settings.platformAccessPriceHalalas || 175000, note);
      else if (action === 'suspend') await suspendAccess(userId, note);
      else if (action === 'reactivate') await reactivateAccess(userId, note);
      else if (action === 'update_receivable') await updateReceivable(userId, amountHalalas, note);
      else return res.status(400).json({ success: false, message: 'إجراء غير معروف' });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  canOpenAdminConsole,
  createAdminRoutes,
};
