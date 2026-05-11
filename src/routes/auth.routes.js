'use strict';

const express = require('express');
const { createAuthController } = require('../controllers/auth.controller');

function createAuthRoutes(deps = {}) {
  const router = express.Router();
  const controller = createAuthController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.post('/api/auth/login', controller.login);
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
