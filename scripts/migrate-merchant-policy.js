'use strict';

const fs = require('node:fs');

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

async function runMerchantPolicyMigration({
  database,
  apply = false,
  rollbackSink,
} = {}) {
  if (!database
      || typeof database.query !== 'function'
      || typeof database.transaction !== 'function') {
    throw new TypeError('An injected database is required');
  }
  if (apply && typeof rollbackSink !== 'function') {
    throw new TypeError('apply requires a rollbackSink');
  }

  const selected = await database.query(
    'SELECT user_id, config FROM bot_configs ORDER BY user_id',
  );
  const merchants = selected.rows.map((row) => {
    const migrated = migrateLegacyConfig(normalizeConfig(row.config));
    return {
      userId: row.user_id,
      status: migrated.report.status,
      reviewItems: migrated.report.reviewItems,
      migratedConfig: migrated.migratedConfig,
      rollbackConfig: migrated.rollbackConfig,
    };
  });
  const reviewIds = merchants
    .filter((merchant) => merchant.reviewItems.length > 0)
    .map((merchant) => merchant.userId);

  if (!apply) {
    return {
      mode: 'dry-run',
      applied: 0,
      reviewIds,
      merchants,
    };
  }

  await rollbackSink({
    merchantConfigs: merchants.map((merchant) => ({
      userId: merchant.userId,
      config: merchant.rollbackConfig,
    })),
  });

  await database.transaction(async (client) => {
    for (const merchant of merchants) {
      const updated = await client.query(
        `UPDATE bot_configs
         SET config = $2::jsonb, updated_at = NOW()
         WHERE user_id = $1`,
        [merchant.userId, merchant.migratedConfig],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Merchant config disappeared during migration: ${merchant.userId}`);
      }
    }
  });

  return {
    mode: 'apply',
    applied: merchants.length,
    reviewIds,
    merchants,
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
        ? async (payload) => {
          await fs.promises.writeFile(
            options.rollbackFile,
            `${JSON.stringify(payload, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx' },
          );
        }
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  main,
  parseArgs,
  runMerchantPolicyMigration,
};
