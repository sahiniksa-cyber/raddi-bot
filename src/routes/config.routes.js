'use strict';

const express = require('express');
const { createConfigController } = require('../controllers/config.controller');

function createConfigRoutes(deps) {
  const router = express.Router();
  const controller = createConfigController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.use('/api', requireAuth);
  router.get('/api/config', controller.getConfig);
  router.post('/api/config', controller.saveConfig);
  router.post('/api/clear', controller.clearConversations);

  return router;
}

module.exports = { createConfigRoutes };
