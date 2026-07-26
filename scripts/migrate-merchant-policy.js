'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  migrateLegacyConfig,
} = require('../src/policy/merchant-policy-migrator');

function parseArgs(args) {
  let apply = false;
  let dryRun = false;
  let databaseUrl = null;
  let rollbackFile = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--database-url') {
      databaseUrl = args[index += 1] || null;
    } else if (argument === '--rollback-file') {
      rollbackFile = args[index += 1] || null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (apply && dryRun) throw new Error('--apply and --dry-run are mutually exclusive');
  return { apply, databaseUrl, rollbackFile };
}

function assertLocalDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('--database-url must point to an explicitly local PostgreSQL database');
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('--database-url must be a valid local PostgreSQL URL');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !localHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('--database-url must point to a local PostgreSQL database');
  }
  return databaseUrl;
}

function normalizeConfig(config) {
  if (typeof config === 'string') return JSON.parse(config);
  if (config && typeof config === 'object' && !Array.isArray(config)) return config;
  throw new TypeError('bot_configs.config must be a JSON object');
}

function requireConfigRaw(row) {
  if (typeof row.config_raw !== 'string') {
    throw new TypeError('bot_configs.config must be selected as exact JSONB text');
  }
  return row.config_raw;
}

function buildMerchantPlans(rows) {
  return rows.map((row) => {
    const configRaw = requireConfigRaw(row);
    const originalConfig = normalizeConfig(configRaw);
    const migrated = migrateLegacyConfig(originalConfig);
    return {
      userId: row.user_id,
      status: migrated.report.status,
      reviewItems: migrated.report.reviewItems,
      migratedConfig: migrated.migratedConfig,
      rollbackConfigRaw: configRaw,
    };
  });
}

function migrationResult(mode, merchants) {
  return {
    mode,
    applied: mode === 'apply' ? merchants.length : 0,
    reviewIds: merchants
      .filter((merchant) => merchant.reviewItems.length > 0)
      .map((merchant) => merchant.userId),
    merchants,
  };
}

async function runMerchantPolicyMigration({
  database,
  apply = false,
  rollbackSink,
} = {}) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('An injected database is required');
  }
  if (apply && typeof rollbackSink !== 'function') {
    throw new TypeError('apply requires a rollbackSink');
  }

  if (!apply) {
    const selected = await database.query(
      `SELECT user_id, config::text AS config_raw
       FROM bot_configs
       ORDER BY user_id`,
    );
    return migrationResult('dry-run', buildMerchantPlans(selected.rows));
  }
  if (typeof database.transaction !== 'function') {
    throw new TypeError('apply requires an injected database transaction');
  }

  return database.transaction(async (client) => {
    const selected = await client.query(
      `SELECT user_id, config::text AS config_raw
       FROM bot_configs
       ORDER BY user_id
       FOR UPDATE`,
    );
    const merchants = buildMerchantPlans(selected.rows);
    await rollbackSink({
      merchantConfigs: merchants.map((merchant) => ({
        userId: merchant.userId,
        configRaw: merchant.rollbackConfigRaw,
      })),
    });
    for (const merchant of merchants) {
      const updated = await client.query(
        `UPDATE bot_configs
         SET config = jsonb_set(config, '{merchantPolicy}', $2::jsonb, true),
             updated_at = NOW()
         WHERE user_id = $1`,
        [
          merchant.userId,
          JSON.stringify(merchant.migratedConfig.merchantPolicy),
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Merchant config disappeared during migration: ${merchant.userId}`);
      }
    }
    return migrationResult('apply', merchants);
  });
}

async function restoreMerchantPolicyConfigs({ database, snapshot } = {}) {
  if (!database || typeof database.transaction !== 'function') {
    throw new TypeError('An injected database transaction is required');
  }
  if (!snapshot || !Array.isArray(snapshot.merchantConfigs)) {
    throw new TypeError('A preserved merchant config snapshot is required');
  }

  return database.transaction(async (client) => {
    for (const preserved of snapshot.merchantConfigs) {
      if (typeof preserved.userId !== 'string' || typeof preserved.configRaw !== 'string') {
        throw new TypeError('Rollback entries require userId and exact configRaw text');
      }
      const updated = await client.query(
        `UPDATE bot_configs
         SET config = $2::jsonb, updated_at = NOW()
         WHERE user_id = $1`,
        [preserved.userId, preserved.configRaw],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Merchant config disappeared during rollback: ${preserved.userId}`);
      }
    }
  });
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EPERM',
]);

async function syncParentDirectory(filePath, fsPromises) {
  let directoryHandle;
  try {
    directoryHandle = await fsPromises.open(path.dirname(filePath), 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) throw error;
  } finally {
    if (directoryHandle) await directoryHandle.close();
  }
}

function createRollbackFileSink(filePath, { fsPromises = fs.promises } = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('A rollback file path is required');
  }
  return async (payload) => {
    const handle = await fsPromises.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncParentDirectory(filePath, fsPromises);
  };
}

function summarizeMigrationResult(result) {
  return {
    mode: result.mode,
    applied: result.applied,
    reviewIds: result.reviewIds,
    merchants: result.merchants.map((merchant) => ({
      userId: merchant.userId,
      status: merchant.status,
      reviewItems: merchant.reviewItems,
    })),
  };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const connectionString = assertLocalDatabaseUrl(options.databaseUrl);
  if (options.apply && !options.rollbackFile) {
    throw new Error('--apply requires --rollback-file');
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: false,
    max: 1,
  });
  const database = {
    query: pool.query.bind(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };

  try {
    const result = await runMerchantPolicyMigration({
      database,
      apply: options.apply,
      rollbackSink: options.apply
        ? createRollbackFileSink(options.rollbackFile)
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(summarizeMigrationResult(result), null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Merchant policy migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertLocalDatabaseUrl,
  createRollbackFileSink,
  main,
  parseArgs,
  restoreMerchantPolicyConfigs,
  runMerchantPolicyMigration,
  summarizeMigrationResult,
};
