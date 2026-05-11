'use strict';

const express = require('express');
const { createQueueController } = require('../controllers/queue.controller');

function createQueueRoutes(deps = {}) {
  const router = express.Router();
  const controller = createQueueController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.use('/api/queues', requireAuth);
  router.get('/api/queues/stats', controller.stats);

  return router;
}

module.exports = { createQueueRoutes };
