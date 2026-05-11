'use strict';

const { createBotRoutes } = require('./bot.routes');
const { createConfigRoutes } = require('./config.routes');
const { createDashboardRoutes } = require('./dashboard.routes');
const { createHealthRoutes } = require('./health.routes');
const { createQueueRoutes } = require('./queue.routes');

function mountRoutes(app, deps = {}) {
  app.use(createHealthRoutes(deps));
  app.use(createDashboardRoutes(deps));
  app.use(createBotRoutes(deps));
  app.use(createConfigRoutes(deps));
  app.use(createQueueRoutes(deps));
  return app;
}

module.exports = {
  createBotRoutes,
  createConfigRoutes,
  createDashboardRoutes,
  createHealthRoutes,
  createQueueRoutes,
  mountRoutes,
};
