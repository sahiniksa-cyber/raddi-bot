'use strict';

const path = require('path');

function createDashboardController({ dashboardDir = path.join(process.cwd(), 'dashboard') } = {}) {
  return {
    login(req, res) {
      if (req.session?.userId) return res.redirect('/');
      return res.sendFile(path.join(dashboardDir, 'login.html'));
    },

    dashboard(req, res) {
      return res.sendFile(path.join(dashboardDir, 'index.html'));
    },
  };
}

module.exports = { createDashboardController };
