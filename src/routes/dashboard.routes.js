'use strict';

const express = require('express');
const { createDashboardController } = require('../controllers/dashboard.controller');

function createDashboardRoutes(deps = {}) {
  const router = express.Router();
  const controller = createDashboardController(deps);
  const requireAuth = deps.requireAuth || ((req, res, next) => next());

  router.get('/login', controller.login);
  router.get('/', requireAuth, controller.dashboard);

  return router;
}

module.exports = { createDashboardRoutes };
