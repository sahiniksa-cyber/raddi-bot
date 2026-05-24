'use strict';

const path = require('path');
const express = require('express');
const db = require('../db/client');
const { getActiveMonitor } = require('../services/monitoring/health-monitor');
const { listRecentIncidents } = require('../services/monitoring/incident-store');

const {
  grantFreeAccess,
  isAdminUser,
  listAdminCustomers,
  markPaidAccess,
  reactivateAccess,
  setAccessExpiry,
  suspendAccess,
  updateReceivable,
} = require('../services/billing/billing-service');
const { addMessagesToQuota } = require('../services/billing/message-quota');

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
      if (req.session?.isAdmin === true) return next();
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

  // Admin login page
  router.get('/admin-login', (req, res) => {
    res.sendFile(path.join(dashboardDir, 'admin-login.html'));
  });

  // Admin login API
  router.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || password !== adminPassword) {
      return res.status(401).json({ success: false, message: 'كلمة مرور خاطئة' });
    }
    req.session.isAdmin = true;
    return res.json({ success: true, redirect: settings.adminSecretPath });
  });

  router.get(settings.adminSecretPath, requireOwner, (req, res) => {
    res.sendFile(path.join(dashboardDir, 'admin.html'));
  });

  // Platform health snapshot + recent incidents for the 24/7 monitoring console.
  router.get('/api/admin/health', requireOwner, async (req, res, next) => {
    try {
      const monitor = getActiveMonitor();
      const snapshot = monitor ? monitor.getSnapshot() : { ok: null, checks: [], at: null };
      const incidents = await listRecentIncidents(db, 30);
      res.json({ success: true, snapshot, incidents });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/admin/customers', requireOwner, async (req, res, next) => {
    try {
      res.json({ success: true, customers: await listAdminCustomers() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/admin/customers/:userId/action', requireOwner, async (req, res, next) => {
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

  // Set access days for a customer
  router.post('/api/admin/customers/:userId/set-days', requireOwner, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const days = parseInt(req.body?.days, 10) || 0;
      const note = String(req.body?.note || '').trim();
      if (!days) return res.status(400).json({ success: false, message: 'عدد الأيام غير صحيح' });
      await setAccessExpiry(userId, days, note);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // Add messages to a customer's quota (admin manual top-up)
  router.post('/api/admin/customers/:userId/add-messages', requireOwner, async (req, res, next) => {
    try {
      const { userId } = req.params;
      const messages = parseInt(req.body?.messages, 10) || 0;
      const days = parseInt(req.body?.days, 10) || 0;
      const expireResetsQuota = req.body?.expireResetsQuota !== false;

      if (messages <= 0) return res.status(400).json({ success: false, message: 'عدد الرسائل غير صحيح' });
      if (days <= 0) return res.status(400).json({ success: false, message: 'عدد الأيام غير صحيح' });

      const result = await addMessagesToQuota(userId, { messages, days, expireResetsQuota });
      res.json({
        success: true,
        messagesRemaining: result.messages_remaining,
        quotaExpiresAt: result.quota_expires_at,
        expireResetsQuota: result.expire_resets_quota,
        lastTopupAmount: result.last_topup_amount,
        lastTopupAt: result.last_topup_at,
      });
    } catch (err) {
      next(err);
    }
  });

  // Coupon CRUD
  router.get('/api/admin/coupons', requireOwner, async (req, res, next) => {
    try {
      const result = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
      res.json({ success: true, coupons: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/admin/coupons', requireOwner, async (req, res, next) => {
    try {
      const { code, type, discountPercent, maxUses } = req.body || {};
      if (!code || !code.trim()) return res.status(400).json({ success: false, message: 'كود الكوبون مطلوب' });
      const validTypes = ['free_activation', 'discount_percent'];
      const couponType = validTypes.includes(type) ? type : 'free_activation';
      const discount = parseInt(discountPercent, 10) || 0;
      const max = parseInt(maxUses, 10) || 1;
      await db.query(
        'INSERT INTO coupons (code, type, discount_percent, max_uses) VALUES ($1, $2, $3, $4)',
        [code.trim(), couponType, discount, max]
      );
      res.json({ success: true });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'هذا الكود موجود مسبقاً' });
      }
      next(err);
    }
  });

  router.delete('/api/admin/coupons/:id', requireOwner, async (req, res, next) => {
    try {
      const { id } = req.params;
      await db.query('UPDATE coupons SET active = FALSE WHERE id = $1', [id]);
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
