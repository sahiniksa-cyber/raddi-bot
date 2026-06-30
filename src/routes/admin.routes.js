'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
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
const { setAdminApiKey, getAdminApiKeysMasked } = require('../services/admin/admin-api-keys');
const {
  setCustomerApiKey,
  getCustomerApiKeysMaskedFor,
} = require('../services/admin/customer-api-keys');
const {
  createPreActivation,
  listPreActivations,
  deletePreActivation,
} = require('../services/admin/pre-activations');
const { createAdminMerchantController } = require('../controllers/admin-merchant.controller');
const { listAdminAuditLog, logAdminAction } = require('../services/admin/admin-audit');
const { copyMerchantConfigByEmail } = require('../services/admin/copy-merchant-config');
const {
  getPlatformSetting: getPlatformSettingDefault,
  setPlatformSetting: setPlatformSettingDefault,
} = require('../services/platform/platform-settings');

// Set when the server process boots (module load ≈ deploy start). Lets the admin
// page show WHICH build is live so a stale browser cache / non-applied deploy is
// obvious at a glance.
const SERVER_BOOT_TIME = new Date().toISOString();
const DEPLOY_COMMIT = String(
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || process.env.SOURCE_VERSION || 'local',
).slice(0, 7);

// Constant-time string compare (SEC-3). Hash both sides to a fixed 32-byte
// digest first so timingSafeEqual never throws on length mismatch and no length
// information leaks via timing.
function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function canOpenAdminConsole({ path: requestPath, user, settings }) {
  if (!settings?.adminSecretPath || requestPath !== settings.adminSecretPath) return false;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (settings.adminEmails || []).includes(String(user.email || '').toLowerCase());
}

function createAdminApiKeysHandlers(deps = {}) {
  const getMasked = deps.getAdminApiKeysMasked || getAdminApiKeysMasked;
  const setKey = deps.setAdminApiKey || setAdminApiKey;

  async function getApiKeys(req, res) {
    try {
      const keys = await getMasked();
      res.status(200).json({ success: true, keys });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async function putApiKey(req, res) {
    try {
      const { provider, apiKey } = req.body || {};
      const result = await setKey(provider, apiKey, req.session?.userId);
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      const isClient = /provider/i.test(err.message);
      res.status(isClient ? 400 : 500).json({ success: false, message: err.message });
    }
  }

  return { getApiKeys, putApiKey };
}

function createCustomerApiKeysHandlers(deps = {}) {
  const getMasked = deps.getCustomerApiKeysMaskedFor || getCustomerApiKeysMaskedFor;
  const setKey = deps.setCustomerApiKey || setCustomerApiKey;

  async function getKeys(req, res) {
    try {
      const userId = String(req.params?.userId || '').trim();
      if (!userId) return res.status(400).json({ success: false, message: 'userId مطلوب' });
      const keys = await getMasked(userId);
      res.status(200).json({ success: true, keys });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async function putKey(req, res) {
    try {
      const userId = String(req.params?.userId || '').trim();
      if (!userId) return res.status(400).json({ success: false, message: 'userId مطلوب' });
      const { provider, apiKey } = req.body || {};
      const result = await setKey({
        userId,
        provider,
        apiKey,
        adminUserId: req.session?.userId,
      });
      // Always return the masked value (never plaintext) so the UI can render
      // the new state without exposing the secret.
      const all = await getMasked(userId);
      const slot = all[result.provider] || { masked: null, hasKey: false };
      res.status(200).json({
        success: true,
        provider: result.provider,
        cleared: Boolean(result.cleared),
        masked: slot.masked,
        hasKey: slot.hasKey,
      });
    } catch (err) {
      const isClient = /provider|userId/i.test(err.message);
      res.status(isClient ? 400 : 500).json({ success: false, message: err.message });
    }
  }

  return { getKeys, putKey };
}

function createQuotaStopMessageHandlers(deps = {}) {
  const getPS = deps.getPlatformSetting || getPlatformSettingDefault;
  const setPS = deps.setPlatformSetting || setPlatformSettingDefault;

  async function getQuotaStopMessage(req, res) {
    try {
      const setting = await getPS('quotaStopMessage');
      res.status(200).json({ success: true, setting: setting || { enabled: false, text: '' } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  async function putQuotaStopMessage(req, res) {
    try {
      const enabled = req.body?.enabled === true;
      const text = String(req.body?.text || '').trim();
      await setPS('quotaStopMessage', { enabled, text });
      res.status(200).json({ success: true, setting: { enabled, text } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  return { getQuotaStopMessage, putQuotaStopMessage };
}

function createAdminRoutes(deps = {}) {
  const router = express.Router();
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const dashboardDir = deps.dashboardDir || path.join(process.cwd(), 'dashboard');
  const settings = deps.billingSettings || {};
  const rateLimitFactory = deps.rateLimitFactory || rateLimit;

  // Admin login: tight rate limit + IP-based lockout window.
  // 5 attempts per IP per 15-minute window — caps brute force on the
  // ADMIN_PASSWORD even if it's leaked from a network log.
  const adminLoginLimiter = rateLimitFactory({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'too_many_attempts', message: 'محاولات كثيرة، حاول لاحقاً' },
  });

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

  // Admin login API — rate limited, and (by default) requires a user session
  // first. The latter prevents drive-by admin-password guessing from clients
  // that never logged in as a normal user. Set ADMIN_REQUIRE_USER_SESSION=false
  // to disable the prerequisite if you need to bootstrap admin access without
  // a user account (any other value, including unset, enforces the check).
  router.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    if (process.env.ADMIN_REQUIRE_USER_SESSION !== 'false' && !req.session?.userId) {
      return res.status(401).json({ success: false, error: 'login_required_first', message: 'يلزم تسجيل الدخول أولاً' });
    }
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || !timingSafeEqualStr(password, adminPassword)) {
      return res.status(401).json({ success: false, message: 'كلمة مرور خاطئة' });
    }
    // SEC-2: rotate the session id on privilege elevation (fixation defence)
    // while preserving the already-authenticated user identity. Guarded for
    // test stubs whose session has no regenerate().
    const finish = () => res.json({ success: true, redirect: settings.adminSecretPath });
    if (req.session && typeof req.session.regenerate === 'function') {
      const uid = req.session.userId;
      const uname = req.session.userName;
      return req.session.regenerate((err) => {
        if (err) return res.status(500).json({ success: false, message: 'session error' });
        req.session.userId = uid;
        req.session.userName = uname;
        req.session.isAdmin = true;
        return req.session.save(() => finish());
      });
    }
    req.session.isAdmin = true;
    return finish();
  });

  router.get(settings.adminSecretPath, requireOwner, (req, res) => {
    // No-store so a redeploy's admin.html shows up immediately — the page was
    // being served from the browser cache, which made updates look "not applied".
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(dashboardDir, 'admin.html'));
  });

  // Which build is live + when it started — so a stale cache / non-applied
  // deploy is obvious from the admin page.
  router.get('/api/admin/version', requireOwner, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, commit: DEPLOY_COMMIT, startedAt: SERVER_BOOT_TIME, node: process.version });
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

  // Quota-stop message: platform admin can enable/disable and set the text that
  // gets sent to customers whose quota is exhausted.
  const quotaStopMessageHandlers = createQuotaStopMessageHandlers();
  router.get('/api/admin/quota-stop-message', requireOwner, quotaStopMessageHandlers.getQuotaStopMessage);
  router.put('/api/admin/quota-stop-message', requireOwner, quotaStopMessageHandlers.putQuotaStopMessage);

  const apiKeyHandlers = createAdminApiKeysHandlers();
  router.get('/api/admin/api-keys', requireOwner, apiKeyHandlers.getApiKeys);
  router.put('/api/admin/api-keys', requireOwner, apiKeyHandlers.putApiKey);

  // Per-customer overrides — these take precedence over the global admin keys
  // for the targeted user (see resolveEffectiveApiKeys).
  const customerApiKeyHandlers = createCustomerApiKeysHandlers();
  const customerApiKeyPutLimiter = rateLimitFactory({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'too_many_attempts', message: 'محاولات كثيرة، حاول لاحقاً' },
  });
  router.get(
    '/api/admin/customers/:userId/api-keys',
    requireOwner,
    customerApiKeyHandlers.getKeys,
  );
  router.put(
    '/api/admin/customers/:userId/api-keys',
    requireOwner,
    customerApiKeyPutLimiter,
    customerApiKeyHandlers.putKey,
  );

  // Pre-activations: admin pre-registers an email + duration so that when the
  // customer signs up with that email their account is auto-activated.
  router.post('/api/admin/pre-activations', requireOwner, async (req, res) => {
    try {
      const { email, durationDays, messages, note } = req.body || {};
      const row = await createPreActivation({
        email,
        durationDays, // empty/0 => permanent (handled in createPreActivation)
        messages,
        note,
        createdByAdmin: req.session?.userId || null,
      });
      res.json({ success: true, preActivation: row });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  router.get('/api/admin/pre-activations', requireOwner, async (req, res, next) => {
    try {
      const rows = await listPreActivations({ includeUsed: req.query.includeUsed === '1' });
      res.json({ success: true, items: rows });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/admin/pre-activations/:id', requireOwner, async (req, res, next) => {
    try {
      const result = await deletePreActivation({ id: Number(req.params.id) });
      res.json({ success: true, deleted: result.deleted });
    } catch (err) {
      next(err);
    }
  });

  // Account migration: copy ALL settings (config + per-customer API keys +
  // learned replies) from one platform account to another, by email. For a
  // merchant who changed her dashboard login and started with an empty account.
  router.post('/api/admin/copy-merchant-config', requireOwner, async (req, res) => {
    const { srcEmail, dstEmail } = req.body || {};
    const adminUserId = req.session?.userId || null;
    try {
      const result = await copyMerchantConfigByEmail(srcEmail, dstEmail, { adminUserId });
      await logAdminAction({
        adminUserId,
        action: 'copy_merchant_config',
        targetUserId: result.dstUserId,
        detail: { srcUserId: result.srcUserId, ...result },
      });
      res.json({ success: true, ...result });
    } catch (err) {
      try {
        await logAdminAction({
          adminUserId,
          action: 'copy_merchant_config',
          detail: { srcEmail, dstEmail, error: err.message },
          result: 'error',
        });
      } catch (_) { /* audit best-effort */ }
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ---- Per-merchant bot control panel (admin) ----
  // Only mounted when a bot resolver is injected (server.js passes getUserBot).
  // Kept additive: existing merchant routes/controllers are untouched.
  if (typeof deps.getUserBot === 'function') {
    const merchant = deps.adminMerchantController
      || createAdminMerchantController({ getUserBot: deps.getUserBot, database: deps.database || db });

    // Tight rate limit on the powerful/destructive bot actions (defense in
    // depth on top of the global /api limiter) — caps a stuck button or an
    // errant script from hammering restart/clear-session across merchants.
    const botActionLimiter = rateLimitFactory({
      windowMs: 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'too_many_attempts', message: 'محاولات كثيرة، حاول لاحقاً' },
    });

    // Search must be registered before nothing shadows it (it doesn't collide
    // with /:userId/* since there's no bare GET /:userId route).
    router.get('/api/admin/customers/search', requireOwner, merchant.search);
    router.get('/api/admin/customers/:userId/diagnostics', requireOwner, merchant.diagnostics);
    router.get('/api/admin/customers/:userId/bot/qr-image', requireOwner, merchant.qrImage);
    router.post('/api/admin/customers/:userId/bot/restart', requireOwner, botActionLimiter, merchant.restart);
    router.post('/api/admin/customers/:userId/bot/stop', requireOwner, botActionLimiter, merchant.stop);
    router.post('/api/admin/customers/:userId/bot/clear-session', requireOwner, botActionLimiter, merchant.clearSession);
    router.post('/api/admin/customers/:userId/bot/release-lease', requireOwner, botActionLimiter, merchant.releaseLease);

    router.get('/api/admin/customers/:userId/audit-log', requireOwner, async (req, res, next) => {
      try {
        const items = await listAdminAuditLog({ targetUserId: req.params.userId, limit: req.query.limit }, { db });
        res.json({ success: true, items });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

module.exports = {
  canOpenAdminConsole,
  createAdminRoutes,
  createAdminApiKeysHandlers,
  createCustomerApiKeysHandlers,
  createQuotaStopMessageHandlers,
};
