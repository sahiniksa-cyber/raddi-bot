'use strict';

const express = require('express');
const { createBotController } = require('../controllers/bot.controller');

function createBotRoutes(deps) {
  const router = express.Router();
  const controller = createBotController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.use('/api', requireAuth);
  router.get('/api/status', controller.status);
  router.get('/api/qr', controller.qr);
  router.get('/api/qr-image', controller.qrImage);
  router.post('/api/bot/start', controller.start);
  router.post('/api/bot/stop', controller.stop);
  router.post('/api/bot/clear-session', controller.clearSession);
  router.post('/api/send-message', controller.sendMessage);

  return router;
}

module.exports = { createBotRoutes };
