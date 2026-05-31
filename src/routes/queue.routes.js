'use strict';

const express = require('express');
const { createQueueController } = require('../controllers/queue.controller');

// Owner-only guard for platform-wide queue stats. Mirrors the session.isAdmin
// check used by admin.routes.js `requireOwner` — the queue stats expose
// platform-wide counts that must never be visible to a normal tenant.
function requireQueueOwner(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  return res.status(403).json({ success: false, message: 'غير مصرح' });
}

function createQueueRoutes(deps = {}) {
  const router = express.Router();
  const controller = createQueueController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.use('/api/queues', requireAuth);
  router.get('/api/queues/stats', requireQueueOwner, controller.stats);

  return router;
}

module.exports = { createQueueRoutes, requireQueueOwner };
