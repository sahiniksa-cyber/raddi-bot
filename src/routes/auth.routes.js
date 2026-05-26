'use strict';

const express = require('express');
const { createAuthController } = require('../controllers/auth.controller');

const LOGIN_LIMITER_DEFAULTS = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة للدخول. حاول بعد 15 دقيقة.' },
};

function createAuthRoutes(deps = {}) {
  const router = express.Router();
  const controller = createAuthController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());
  const rateLimitFactory = deps.rateLimitFactory || require('express-rate-limit');

  const loginLimiter = rateLimitFactory(LOGIN_LIMITER_DEFAULTS);

  router.post('/api/auth/login', loginLimiter, controller.login);
  router.post('/api/auth/register', controller.register);
  router.post('/api/auth/logout', controller.logout);
  router.get('/api/auth/me', controller.me);
  router.post('/api/auth/change-password', requireAuth, controller.changePassword);

  router.post('/api/auth/verify-email', (req, res) => res.json({ success: true, verified: true }));
  router.post('/api/auth/resend-code', (req, res) => res.json({ success: true }));
  router.post('/api/auth/forgot-password', (req, res) => res.json({ success: false, message: 'استعادة كلمة المرور غير مفعلة في الخادم الجديد بعد' }));
  router.post('/api/auth/reset-password', (req, res) => res.json({ success: false, message: 'استعادة كلمة المرور غير مفعلة في الخادم الجديد بعد' }));

  return router;
}

module.exports = { createAuthRoutes };
