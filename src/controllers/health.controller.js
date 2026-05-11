'use strict';

const db = require('../db/client');
const redis = require('../queues/redis');

function createHealthController({ storageStatus = null } = {}) {
  return {
    basic(req, res) {
      res.json({ ok: true, ts: Date.now() });
    },

    storage(req, res) {
      res.json(storageStatus || { persistent: false, warning: 'storageStatus dependency not provided' });
    },

    async readiness(req, res) {
      const checks = {
        app: true,
        database: false,
        redis: false,
      };

      try {
        if (db.isConfigured()) {
          await db.ping();
          checks.database = true;
        }
      } catch (err) {
        checks.databaseError = err.message;
      }

      try {
        if (redis.getRedisUrl()) {
          checks.redis = (await redis.ping()) === 'PONG';
        }
      } catch (err) {
        checks.redisError = err.message;
      }

      const ok = checks.app && checks.database && checks.redis;
      res.status(ok ? 200 : 503).json({ ok, checks, ts: Date.now() });
    },
  };
}

module.exports = { createHealthController };
