'use strict';

const path = require('path');

const db = require('../db/client');
const redis = require('../queues/redis');
const { inspectStorageRoot } = require('../services/storage/volume-inspector');

function uniqueRoots(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => path.resolve(value)))];
}

function storageDiagnostics(storageStatus = {}) {
  const roots = uniqueRoots([
    storageStatus.path,
    storageStatus.sessionRoot,
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    process.env.DATA_DIR,
    path.join(process.cwd(), 'data'),
    '/data',
  ]);

  return roots.map(root => inspectStorageRoot(root, { maxEntries: 12 }));
}

function createHealthController({ storageStatus = null } = {}) {
  return {
    basic(req, res) {
      res.json({ ok: true, ts: Date.now() });
    },

    storage(req, res) {
      const payload = storageStatus || { persistent: false, warning: 'storageStatus dependency not provided' };
      if (req.query?.inspect !== '1') return res.json(payload);
      if (!req.session?.userId) {
        return res.status(401).json({ success: false, message: 'غير مصرح' });
      }
      return res.json({
        ...payload,
        diagnostics: storageDiagnostics(payload),
      });
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
        // Do NOT leak driver error details to clients — log only.
        console.error(`[ready] database ping failed: ${err.stack || err.message}`);
        checks.database = false;
        checks.databaseStatus = 'db_unhealthy';
      }

      try {
        if (redis.getRedisUrl()) {
          checks.redis = (await redis.ping()) === 'PONG';
        }
      } catch (err) {
        console.error(`[ready] redis ping failed: ${err.stack || err.message}`);
        checks.redis = false;
        checks.redisStatus = 'redis_unhealthy';
      }

      const ok = checks.app && checks.database && checks.redis;
      res.status(ok ? 200 : 503).json({ ok, checks, ts: Date.now() });
    },
  };
}

module.exports = { createHealthController };
