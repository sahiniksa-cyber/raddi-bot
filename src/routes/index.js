'use strict';

const { createBotRoutes } = require('./bot.routes');
const { createConfigRoutes } = require('./config.routes');
const { createDashboardRoutes } = require('./dashboard.routes');
const { createHealthRoutes } = require('./health.routes');
const { createQueueRoutes } = require('./queue.routes');
const { createAuthRoutes } = require('./auth.routes');

function mountRoutes(app, deps = {}) {
  app.use(createHealthRoutes(deps));
  app.use(createAuthRoutes(deps));
  app.use(createDashboardRoutes(deps));
  app.use(createBotRoutes(deps));
  app.use(createConfigRoutes(deps));
  app.use(createQueueRoutes(deps));
  return app;
}

module.exports = {
  createBotRoutes,
  createConfigRoutes,
  createAuthRoutes,
  createDashboardRoutes,
  createHealthRoutes,
  createQueueRoutes,
  mountRoutes,
};
