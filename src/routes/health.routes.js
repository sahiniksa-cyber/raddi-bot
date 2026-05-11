'use strict';

const express = require('express');
const { createHealthController } = require('../controllers/health.controller');

function createHealthRoutes(deps = {}) {
  const router = express.Router();
  const controller = createHealthController(deps);

  router.get('/health', controller.basic);
  router.get('/ready', controller.readiness);
  router.get('/api/storage-status', controller.storage);

  return router;
}

module.exports = { createHealthRoutes };
