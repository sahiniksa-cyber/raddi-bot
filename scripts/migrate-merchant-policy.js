'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  migrateLegacyConfig,
} = require('../src/policy/merchant-policy-migrator');
const {
  validateMerchantPolicy,
} = require('../src/policy/merchant-policy-schema');

const RAW_CONFIG_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxNumberTokenLength: 1024,
  maxNumberDigits: 512,
  maxExponentMagnitude: 1024,
  maxIssues: 32,
  maxTokenPreviewLength: 64,
});

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

function canonicalDecimalValue(lexeme) {
  const match = lexeme.match(
    /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/,
  );
  if (!match) throw new TypeError(`Invalid JSON number lexeme: ${lexeme}`);
  let coefficient = BigInt(`${match[2]}${match[3] || ''}`);
  let exponent = BigInt(match[4] || '0') - BigInt((match[3] || '').length);
  if (coefficient === 0n) return { coefficient: 0n, exponent: 0n };
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1n;
  }
  if (match[1]) coefficient = -coefficient;
  return { coefficient, exponent };
}

function decimalRational(lexeme) {
  const { coefficient, exponent } = canonicalDecimalValue(lexeme);
  if (coefficient === 0n) return { numerator: 0n, denominator: 1n };
  if (exponent >= 0n) {
    return {
      numerator: coefficient * (10n ** exponent),
      denominator: 1n,
    };
  }
  return {
    numerator: coefficient,
    denominator: 10n ** (-exponent),
  };
}

function doubleRational(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError('Cannot convert a non-finite number to an exact rational');
  }
  if (value === 0) return { numerator: 0n, denominator: 1n };

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = (bits >> 63n) === 1n;
  const exponentBits = (bits >> 52n) & 0x7ffn;
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0n
    ? fraction
    : (1n << 52n) + fraction;
  const exponent = exponentBits === 0n
    ? -1074n
    : exponentBits - 1023n - 52n;
  let numerator = negative ? -significand : significand;
  let denominator = 1n;
  if (exponent >= 0n) {
    numerator <<= exponent;
  } else {
    denominator <<= -exponent;
  }
  return { numerator, denominator };
}

function isExactlyRepresentableAsDouble(lexeme, parsed) {
  const decimal = decimalRational(lexeme);
  const binary = doubleRational(parsed);
  return decimal.numerator * binary.denominator
    === binary.numerator * decimal.denominator;
}

function isDigit(character) {
  return character >= '0' && character <= '9';
}

function readJsonNumberToken(raw, start) {
  let cursor = start;
  if (raw[cursor] === '-') cursor += 1;

  const integerStart = cursor;
  if (raw[cursor] === '0') {
    cursor += 1;
  } else {
    while (isDigit(raw[cursor])) cursor += 1;
  }
  let digitCount = cursor - integerStart;

  if (raw[cursor] === '.') {
    cursor += 1;
    const fractionStart = cursor;
    while (isDigit(raw[cursor])) cursor += 1;
    digitCount += cursor - fractionStart;
  }

  let exponentDigitsStart = null;
  if (raw[cursor] === 'e' || raw[cursor] === 'E') {
    cursor += 1;
    if (raw[cursor] === '+' || raw[cursor] === '-') cursor += 1;
    exponentDigitsStart = cursor;
    while (isDigit(raw[cursor])) cursor += 1;
  }

  return {
    start,
    end: cursor,
    digitCount,
    exponentDigitsStart,
  };
}

function exponentMagnitudeExceeds(raw, token, limit) {
  if (token.exponentDigitsStart === null) return false;
  let cursor = token.exponentDigitsStart;
  while (cursor < token.end && raw[cursor] === '0') cursor += 1;
  const significantLength = token.end - cursor;
  const limitText = String(limit);
  if (significantLength !== limitText.length) {
    return significantLength > limitText.length;
  }
  for (let index = 0; index < limitText.length; index += 1) {
    if (raw[cursor + index] === limitText[index]) continue;
    return raw[cursor + index] > limitText[index];
  }
  return false;
}

function numericIssue(raw, token, reason) {
  const tokenLength = token.end - token.start;
  const lexeme = tokenLength <= RAW_CONFIG_LIMITS.maxNumberTokenLength
    ? raw.substring(token.start, token.end)
    : `${raw.substring(
      token.start,
      token.start + RAW_CONFIG_LIMITS.maxTokenPreviewLength,
    )}…`;
  return {
    lexeme,
    offset: token.start,
    reason,
    tokenLength,
    digitCount: token.digitCount,
    code: 'unsafe_json_number',
  };
}

function findUnsafeJsonNumbers(raw) {
  const issues = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== '-' && !isDigit(character)) continue;

    const token = readJsonNumberToken(raw, index);
    const tokenLength = token.end - token.start;
    let issue = null;
    if (tokenLength > RAW_CONFIG_LIMITS.maxNumberTokenLength) {
      issue = numericIssue(raw, token, 'token_length_limit');
    } else if (token.digitCount > RAW_CONFIG_LIMITS.maxNumberDigits) {
      issue = numericIssue(raw, token, 'digit_count_limit');
    } else if (exponentMagnitudeExceeds(
      raw,
      token,
      RAW_CONFIG_LIMITS.maxExponentMagnitude,
    )) {
      issue = numericIssue(raw, token, 'exponent_magnitude_limit');
    }
    const lexeme = issue
      ? null
      : raw.substring(token.start, token.end);
    if (issue) {
      issues.push(issue);
      if (issues.length >= RAW_CONFIG_LIMITS.maxIssues) return issues;
      index = token.end - 1;
      continue;
    }
    const parsed = Number(lexeme);
    let reason = null;
    if (!Number.isFinite(parsed)) {
      reason = 'non_finite_after_parse';
    } else if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
      reason = 'unsafe_integer';
    } else if (!isExactlyRepresentableAsDouble(lexeme, parsed)) {
      reason = 'precision_loss';
    }
    if (reason) {
      issues.push(numericIssue(raw, token, reason));
      if (issues.length >= RAW_CONFIG_LIMITS.maxIssues) return issues;
    }
    index = token.end - 1;
  }
  return issues;
}

function inspectRawConfig(raw) {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > RAW_CONFIG_LIMITS.maxBytes) {
    return [{
      code: 'raw_config_limit',
      reason: 'config_size_limit',
      offset: 0,
      byteLength,
      limit: RAW_CONFIG_LIMITS.maxBytes,
    }];
  }
  return findUnsafeJsonNumbers(raw);
}

function originalMerchantPolicyFromRow(row) {
  if (typeof row.merchant_policy_present !== 'boolean') {
    throw new TypeError('merchantPolicy presence must be selected from PostgreSQL');
  }
  if (row.merchant_policy_present && typeof row.merchant_policy_raw !== 'string') {
    throw new TypeError('Existing merchantPolicy must be selected as exact JSONB text');
  }
  return {
    present: row.merchant_policy_present,
    raw: row.merchant_policy_present ? row.merchant_policy_raw : null,
  };
}

function buildMerchantPlans(rows) {
  return rows.map((row) => {
    const configRaw = requireConfigRaw(row);
    const rawSafetyIssues = inspectRawConfig(configRaw);
    const numericSafetyIssues = rawSafetyIssues.filter(
      (issue) => issue.code === 'unsafe_json_number',
    );
    const originalMerchantPolicy = originalMerchantPolicyFromRow(row);
    if (rawSafetyIssues.length > 0) {
      return {
        userId: row.user_id,
        status: 'invalid',
        reviewItems: rawSafetyIssues.map((issue) => ({
          path: `$raw[${issue.offset}]`,
          code: issue.code,
        })),
        rawSafetyIssues,
        numericSafetyIssues,
        migratedConfig: null,
        rollbackConfigRaw: configRaw,
        originalMerchantPolicy,
        appliedPolicyVersion: null,
        appliedMerchantPolicyRaw: null,
      };
    }
    const originalConfig = normalizeConfig(configRaw);
    const migrated = migrateLegacyConfig(originalConfig);
    const migratedPolicy = migrated.migratedConfig?.merchantPolicy;
    const validation = validateMerchantPolicy(migratedPolicy);
    const hasDerivedVersion = validation.ok
      && typeof migratedPolicy?.policyVersion === 'string'
      && migratedPolicy.policyVersion.trim() !== ''
      && migratedPolicy.policyVersion === validation.policyVersion;
    let appliedMerchantPolicyRaw = null;
    if (hasDerivedVersion) {
      try {
        appliedMerchantPolicyRaw = JSON.stringify(migratedPolicy);
      } catch {
        appliedMerchantPolicyRaw = null;
      }
    }
    const canApplyPolicy = typeof appliedMerchantPolicyRaw === 'string'
      && appliedMerchantPolicyRaw.length > 0;
    const reviewItems = canApplyPolicy
      ? migrated.report.reviewItems
      : [
        ...migrated.report.reviewItems,
        { path: 'merchantPolicy', code: 'invalid_applied_policy' },
      ];
    return {
      userId: row.user_id,
      status: canApplyPolicy ? migrated.report.status : 'invalid',
      reviewItems,
      rawSafetyIssues: [],
      numericSafetyIssues: [],
      migratedConfig: migrated.migratedConfig,
      rollbackConfigRaw: configRaw,
      originalMerchantPolicy,
      appliedPolicyVersion: canApplyPolicy ? validation.policyVersion : null,
      appliedMerchantPolicyRaw,
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

function isValidAppliedPolicySnapshot(preserved) {
  if (typeof preserved.appliedPolicyVersion !== 'string'
      || preserved.appliedPolicyVersion.trim() === ''
      || typeof preserved.appliedMerchantPolicyRaw !== 'string'
      || preserved.appliedMerchantPolicyRaw.trim() === '') {
    return false;
  }
  try {
    const parsed = JSON.parse(preserved.appliedMerchantPolicyRaw);
    const validation = validateMerchantPolicy(parsed);
    return validation.ok
      && validation.policyVersion === preserved.appliedPolicyVersion
      && parsed.policyVersion === preserved.appliedPolicyVersion;
  } catch {
    return false;
  }
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
      `SELECT user_id,
              config::text AS config_raw,
              (config ? 'merchantPolicy') AS merchant_policy_present,
              CASE
                WHEN config ? 'merchantPolicy'
                THEN (config->'merchantPolicy')::text
                ELSE NULL
              END AS merchant_policy_raw
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
      `SELECT user_id,
              config::text AS config_raw,
              (config ? 'merchantPolicy') AS merchant_policy_present,
              CASE
                WHEN config ? 'merchantPolicy'
                THEN (config->'merchantPolicy')::text
                ELSE NULL
              END AS merchant_policy_raw
       FROM bot_configs
       ORDER BY user_id
       FOR UPDATE`,
    );
    const merchants = buildMerchantPlans(selected.rows);
    const unsafeMerchants = merchants.filter(
      (merchant) => merchant.rawSafetyIssues.length > 0,
    );
    if (unsafeMerchants.length > 0) {
      const hasRawConfigLimit = unsafeMerchants.some((merchant) => (
        merchant.rawSafetyIssues.some(
          (issue) => issue.code === 'raw_config_limit',
        )
      ));
      const error = new Error(
        `Unsafe raw merchant configs require review: ${unsafeMerchants
          .map((merchant) => merchant.userId)
          .join(', ')}`,
      );
      error.code = hasRawConfigLimit
        ? 'RAW_CONFIG_LIMIT'
        : 'UNSAFE_JSON_NUMBER';
      error.reviewIds = unsafeMerchants.map((merchant) => merchant.userId);
      error.issues = unsafeMerchants.flatMap((merchant) => (
        merchant.rawSafetyIssues.map((issue) => ({
          userId: merchant.userId,
          ...issue,
        }))
      ));
      throw error;
    }
    const invalidPolicyMerchants = merchants.filter(
      (merchant) => typeof merchant.appliedMerchantPolicyRaw !== 'string'
        || merchant.appliedMerchantPolicyRaw.length === 0
        || typeof merchant.appliedPolicyVersion !== 'string'
        || merchant.appliedPolicyVersion.trim() === '',
    );
    if (invalidPolicyMerchants.length > 0) {
      const error = new Error(
        `Invalid migrated merchant policies require review: ${invalidPolicyMerchants
          .map((merchant) => merchant.userId)
          .join(', ')}`,
      );
      error.code = 'INVALID_MERCHANT_POLICY';
      error.reviewIds = invalidPolicyMerchants.map(
        (merchant) => merchant.userId,
      );
      throw error;
    }
    await rollbackSink({
      merchantConfigs: merchants.map((merchant) => ({
        userId: merchant.userId,
        configRaw: merchant.rollbackConfigRaw,
        originalMerchantPolicy: merchant.originalMerchantPolicy,
        appliedPolicyVersion: merchant.appliedPolicyVersion,
        appliedMerchantPolicyRaw: merchant.appliedMerchantPolicyRaw,
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
          merchant.appliedMerchantPolicyRaw,
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
      if (typeof preserved.userId !== 'string'
          || typeof preserved.configRaw !== 'string'
          || typeof preserved.originalMerchantPolicy?.present !== 'boolean'
          || (preserved.originalMerchantPolicy.present
            && typeof preserved.originalMerchantPolicy.raw !== 'string')
          || !isValidAppliedPolicySnapshot(preserved)) {
        throw new TypeError(
          'Rollback entries require exact original and applied policy state',
        );
      }
      const updated = await client.query(
        `UPDATE bot_configs
         SET config = CASE
               WHEN $2::boolean
                 THEN jsonb_set(config, '{merchantPolicy}', $3::jsonb, true)
               ELSE config - 'merchantPolicy'
             END,
             updated_at = NOW()
         WHERE user_id = $1
           AND (
             config->'merchantPolicy' = $4::jsonb
             OR CASE
                  WHEN $2::boolean
                    THEN config ? 'merchantPolicy'
                      AND config->'merchantPolicy' = $3::jsonb
                  ELSE NOT (config ? 'merchantPolicy')
                END
           )`,
        [
          preserved.userId,
          preserved.originalMerchantPolicy.present,
          preserved.originalMerchantPolicy.raw ?? 'null',
          preserved.appliedMerchantPolicyRaw,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Merchant policy rollback conflict: ${preserved.userId}`);
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
