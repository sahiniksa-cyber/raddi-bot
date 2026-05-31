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

// Patterns that indicate an API-key / auth problem in a stored AI error.
// Covers the Arabic operator-facing message ("أضف مفتاح ...") plus common
// English/HTTP signals raised by the AI providers.
const API_KEY_ERROR_RE = /مفتاح|api key|401|unauthorized|invalid api key|no .*key/i;

/**
 * Detect whether any of the given stored error strings indicates a missing or
 * invalid API key. Accepts a single string, an array of strings, or any mix
 * (null/undefined entries are ignored). Returns true on the first match.
 */
function detectApiKeyError(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  for (const entry of list) {
    const text = String(entry || '');
    if (text && API_KEY_ERROR_RE.test(text)) return true;
  }
  return false;
}

function createHealthController({ storageStatus = null } = {}) {
  return {
    basic(req, res) {
      res.json({ ok: true, ts: Date.now() });
    },

    storage(req, res) {
      const payload = storageStatus || { persistent: false, warning: 'storageStatus dependency not provided' };
      // Basic status (ok/not-ok, no cross-tenant paths) is available to any
      // logged-in user. The detailed `inspect=1` filesystem listing leaks other
      // tenants' directory names (data/<otherUserId>/...) and is owner-only.
      if (req.query?.inspect !== '1') return res.json(payload);
      if (req.session?.isAdmin !== true) {
        // Non-admins still get the basic status — never the diagnostics listing.
        return res.json(payload);
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

module.exports = { createHealthController, detectApiKeyError, API_KEY_ERROR_RE };
