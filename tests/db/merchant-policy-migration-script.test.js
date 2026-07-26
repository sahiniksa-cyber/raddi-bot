'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertLocalDatabaseUrl,
  createRollbackFileSink,
  parseArgs,
  restoreMerchantPolicyConfigs,
  runMerchantPolicyMigration,
  summarizeMigrationResult,
} = require('../../scripts/migrate-merchant-policy');
const {
  migrateLegacyConfig,
} = require('../../src/policy/merchant-policy-migrator');

const EMPTY_POLICY_VERSION =
  'sha256:4bace95f29993ac8692842190f8f282f6269d4c94636db3347e305010760722f';
const NULL_POLICY_VERSION =
  'sha256:aae58081cf414fb3c67e3480222ce8dc0a0c7bcb5d24f6a8903bcd5ffb0e826c';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function originalMerchantPolicy(raw) {
  const config = JSON.parse(raw);
  const present = Object.prototype.hasOwnProperty.call(config, 'merchantPolicy');
  return {
    present,
    raw: present ? JSON.stringify(config.merchantPolicy) : null,
  };
}

function makeDatabase(rows) {
  const state = rows.map((row) => {
    const configRaw = row.configRaw ?? JSON.stringify(row.config);
    const originalPolicy = originalMerchantPolicy(configRaw);
    return {
      user_id: row.user_id,
      config_raw: configRaw,
      merchant_policy_present: originalPolicy.present,
      merchant_policy_raw: originalPolicy.raw,
      unrelated_edit: row.unrelatedEdit ?? null,
    };
  });
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params: clone(params) });
      if (
        /^SELECT user_id, config::text AS config_raw,[\s\S]+FROM bot_configs ORDER BY user_id(?: FOR UPDATE)?/i
          .test(
            normalized,
          )
      ) {
        return { rows: clone(state), rowCount: state.length };
      }
      if (/^SELECT user_id, config FROM bot_configs ORDER BY user_id(?: FOR UPDATE)?/i.test(
        normalized,
      )) {
        return {
          rows: state.map((row) => ({
            user_id: row.user_id,
            config: JSON.parse(row.config_raw),
          })),
          rowCount: state.length,
        };
      }
      if (/^UPDATE bot_configs SET config = \$2::jsonb/i.test(normalized)) {
        const row = state.find((candidate) => candidate.user_id === params[0]);
        row.config_raw = typeof params[1] === 'string'
          ? params[1]
          : JSON.stringify(params[1]);
        const policy = originalMerchantPolicy(row.config_raw);
        row.merchant_policy_present = policy.present;
        row.merchant_policy_raw = policy.raw;
        row.unrelated_edit = null;
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE bot_configs SET config = jsonb_set\(/i.test(normalized)) {
        const row = state.find((candidate) => candidate.user_id === params[0]);
        row.merchant_policy_present = true;
        row.merchant_policy_raw = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE bot_configs SET config = CASE/i.test(normalized)) {
        const row = state.find((candidate) => candidate.user_id === params[0]);
        const currentPolicy = row?.merchant_policy_present && row.merchant_policy_raw !== 'null'
          ? JSON.parse(row.merchant_policy_raw)
          : null;
        const enforcesAppliedVersion =
          /config->'merchantPolicy'->>'policyVersion' = \$4/i.test(normalized);
        if (!row || (enforcesAppliedVersion && currentPolicy?.policyVersion !== params[3])) {
          return { rows: [], rowCount: 0 };
        }
        row.merchant_policy_present = params[1];
        row.merchant_policy_raw = params[1] ? params[2] : null;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };
  return {
    state,
    calls,
    database: {
      query: client.query.bind(client),
      async transaction(work) {
        const before = clone(state);
        calls.push({ sql: 'BEGIN', params: [] });
        try {
          const result = await work(client);
          calls.push({ sql: 'COMMIT', params: [] });
          return result;
        } catch (error) {
          state.splice(0, state.length, ...before);
          calls.push({ sql: 'ROLLBACK', params: [] });
          throw error;
        }
      },
    },
  };
}

test('arguments default to dry-run and only explicit --apply enables writes', () => {
  assert.deepEqual(parseArgs([]), { apply: false, databaseUrl: null, rollbackFile: null });
  assert.equal(parseArgs(['--dry-run']).apply, false);
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /mutually exclusive/);
});

test('dry-run preserves legacy fields and emits only merchant IDs needing review', async () => {
  const original = {
    user_id: 'merchant-review',
    config: {
      customLegacyField: { keep: true },
      botInstructions: 'Free-form facts need human review',
    },
  };
  const { database, state, calls } = makeDatabase([
    original,
    { user_id: 'merchant-clean', config: { products: [] } },
  ]);

  const result = await runMerchantPolicyMigration({ database });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, 0);
  assert.deepEqual(result.reviewIds, ['merchant-review']);
  assert.equal(state[0].config_raw, JSON.stringify(original.config));
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
  const reviewed = result.merchants.find((merchant) => merchant.userId === 'merchant-review');
  assert.deepEqual(reviewed.migratedConfig.customLegacyField, { keep: true });
  assert.equal(reviewed.migratedConfig.botInstructions, original.config.botInstructions);
  assert.equal(reviewed.reviewItems[0].code, 'untyped_bot_instructions');
  assert.equal(reviewed.rollbackConfigRaw, JSON.stringify(original.config));
});

test('dry-run needs only an injected query contract and never opens a configured database', async () => {
  const queryOnlyDatabase = {
    async query(sql) {
      assert.match(sql, /config::text AS config_raw/i);
      assert.match(sql, /config \? 'merchantPolicy'/i);
      return {
        rows: [{
          user_id: 'merchant-one',
          config_raw: '{"products":[]}',
          merchant_policy_present: false,
          merchant_policy_raw: null,
        }],
      };
    },
  };

  const result = await runMerchantPolicyMigration({ database: queryOnlyDatabase });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.applied, 0);
});

test('apply saves rollback payload before updating bot_configs and preserves legacy fields', async () => {
  const originalConfig = {
    customLegacyField: 'keep-me',
    products: [],
  };
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: originalConfig },
  ]);
  let rollbackPayload;

  const result = await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      calls.push({ sql: 'PRESERVE_ROLLBACK', params: [] });
      rollbackPayload = clone(payload);
    },
  });

  assert.equal(result.mode, 'apply');
  assert.equal(result.applied, 1);
  assert.deepEqual(rollbackPayload, {
    merchantConfigs: [{
      userId: 'merchant-apply',
      configRaw: JSON.stringify(originalConfig),
      originalMerchantPolicy: {
        present: false,
        raw: null,
      },
      appliedPolicyVersion: EMPTY_POLICY_VERSION,
    }],
  });
  assert.equal(state[0].config_raw, JSON.stringify(originalConfig));
  assert.ok(state[0].merchant_policy_raw);
  assert.ok(
    calls.findIndex((call) => call.sql === 'PRESERVE_ROLLBACK')
      < calls.findIndex((call) => /^UPDATE bot_configs/i.test(call.sql)),
  );
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(
    calls[1].sql,
    /SELECT user_id, config::text AS config_raw,[\s\S]+FROM bot_configs ORDER BY user_id FOR UPDATE/i,
  );
  const update = calls.find((call) => /^UPDATE bot_configs/i.test(call.sql));
  assert.match(update.sql, /jsonb_set\(config, '\{merchantPolicy\}', \$2::jsonb, true\)/i);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('rollback payload preserves an existing merchantPolicy byte-for-byte', async () => {
  const originalConfig = migrateLegacyConfig({
    customLegacyField: 'keep-me',
    products: [],
  }).migratedConfig;
  const { database } = makeDatabase([
    { user_id: 'merchant-existing-policy', config: originalConfig },
  ]);
  let rollbackPayload;

  await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      rollbackPayload = clone(payload);
    },
  });

  assert.deepEqual(rollbackPayload, {
    merchantConfigs: [{
      userId: 'merchant-existing-policy',
      configRaw: JSON.stringify(originalConfig),
      originalMerchantPolicy: {
        present: true,
        raw: JSON.stringify(originalConfig.merchantPolicy),
      },
      appliedPolicyVersion: EMPTY_POLICY_VERSION,
    }],
  });
  assert.equal(
    rollbackPayload.merchantConfigs[0].appliedPolicyVersion,
    originalConfig.merchantPolicy.policyVersion,
  );
});

test('rollback restores only merchantPolicy for absent, null, and present originals', async () => {
  const presentConfig = migrateLegacyConfig({ products: [] }).migratedConfig;
  const seeds = [
    { user_id: 'merchant-absent', configRaw: '{"products":[]}' },
    { user_id: 'merchant-null', configRaw: '{"products":[],"merchantPolicy":null}' },
    { user_id: 'merchant-present', configRaw: JSON.stringify(presentConfig) },
  ];
  const { database, state, calls } = makeDatabase(seeds);
  let rollbackPayload;

  await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      rollbackPayload = clone(payload);
    },
  });
  assert.deepEqual(
    rollbackPayload.merchantConfigs.map((entry) => entry.originalMerchantPolicy),
    [
      { present: false, raw: null },
      { present: true, raw: 'null' },
      {
        present: true,
        raw: JSON.stringify(presentConfig.merchantPolicy),
      },
    ],
  );
  assert.deepEqual(
    rollbackPayload.merchantConfigs.map((entry) => entry.appliedPolicyVersion),
    [EMPTY_POLICY_VERSION, NULL_POLICY_VERSION, EMPTY_POLICY_VERSION],
  );
  state.forEach((row, index) => {
    row.unrelated_edit = `post-migration-${index}`;
  });

  await restoreMerchantPolicyConfigs({ database, snapshot: rollbackPayload });

  assert.deepEqual(
    state.map((row) => ({
      present: row.merchant_policy_present,
      raw: row.merchant_policy_raw,
      unrelatedEdit: row.unrelated_edit,
    })),
    [
      { present: false, raw: null, unrelatedEdit: 'post-migration-0' },
      { present: true, raw: 'null', unrelatedEdit: 'post-migration-1' },
      {
        present: true,
        raw: JSON.stringify(presentConfig.merchantPolicy),
        unrelatedEdit: 'post-migration-2',
      },
    ],
  );
  const restoreUpdate = calls.find((call) => /^UPDATE bot_configs SET config = CASE/i.test(
    call.sql,
  ));
  assert.match(restoreUpdate.sql, /config - 'merchantPolicy'/i);
  assert.match(
    restoreUpdate.sql,
    /config->'merchantPolicy'->>'policyVersion' = \$4/i,
  );
});

test('rollback conflicts atomically when any current merchantPolicy version changed', async () => {
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-first', config: { products: [] } },
    { user_id: 'merchant-conflict', config: { products: [] } },
  ]);
  let rollbackPayload;
  await runMerchantPolicyMigration({
    database,
    apply: true,
    rollbackSink: async (payload) => {
      rollbackPayload = clone(payload);
    },
  });
  state[0].unrelated_edit = 'must-survive';
  state[1].merchant_policy_raw = '{"policyVersion":"sha256:changed"}';
  const beforeRollback = clone(state);

  await assert.rejects(
    restoreMerchantPolicyConfigs({ database, snapshot: rollbackPayload }),
    /rollback conflict.*merchant-conflict/i,
  );

  assert.deepEqual(state, beforeRollback);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('dry-run reports unsafe raw JSON numbers without parsing or changing data', async () => {
  const unsafeProductRaw =
    '{"products":[{"id":"p1","name":"unsafe","price":{"amountMinor":9007199254740993,"currency":"SAR"}}],"botInstructions":"literal 9007199254740993 stays text"}';
  const unsafeDecimalRaw =
    '{"products":[],"legacyDecimal":1.0000000000000001e+0}';
  const unsafeOrdinaryDecimalRaw =
    '{"products":[],"legacyDecimal":0.1}';
  const unsafeSubnormalRaw =
    '{"products":[],"legacyDecimal":1e-323}';
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-unsafe-product', configRaw: unsafeProductRaw },
    { user_id: 'merchant-unsafe-decimal', configRaw: unsafeDecimalRaw },
    {
      user_id: 'merchant-unsafe-ordinary-decimal',
      configRaw: unsafeOrdinaryDecimalRaw,
    },
    { user_id: 'merchant-unsafe-subnormal', configRaw: unsafeSubnormalRaw },
  ]);

  const result = await runMerchantPolicyMigration({ database });

  assert.deepEqual(result.reviewIds, [
    'merchant-unsafe-product',
    'merchant-unsafe-decimal',
    'merchant-unsafe-ordinary-decimal',
    'merchant-unsafe-subnormal',
  ]);
  assert.deepEqual(result.merchants.map((merchant) => merchant.status), [
    'invalid',
    'invalid',
    'invalid',
    'invalid',
  ]);
  assert.deepEqual(
    result.merchants.map((merchant) => merchant.numericSafetyIssues[0].lexeme),
    ['9007199254740993', '1.0000000000000001e+0', '0.1', '1e-323'],
  );
  assert.equal(
    result.merchants.every(
      (merchant) => merchant.reviewItems[0].code === 'unsafe_json_number',
    ),
    true,
  );
  assert.deepEqual(state.map((row) => row.config_raw), [
    unsafeProductRaw,
    unsafeDecimalRaw,
    unsafeOrdinaryDecimalRaw,
    unsafeSubnormalRaw,
  ]);
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
});

test('apply fails closed on unsafe raw numbers before rollback preservation or UPDATE', async () => {
  const unsafeRaw =
    '{"products":[{"name":"unsafe","price":{"amountMinor":9007199254740993,"currency":"SAR"}}]}';
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-unsafe', configRaw: unsafeRaw },
  ]);
  let preserved = false;

  await assert.rejects(
    runMerchantPolicyMigration({
      database,
      apply: true,
      rollbackSink: async () => {
        preserved = true;
      },
    }),
    (error) => error.code === 'UNSAFE_JSON_NUMBER'
      && error.reviewIds.includes('merchant-unsafe'),
  );

  assert.equal(preserved, false);
  assert.equal(state[0].config_raw, unsafeRaw);
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('raw numeric safety accepts exactly round-trippable decimals and exponents', async () => {
  const { database } = makeDatabase([
    {
      user_id: 'merchant-safe-numbers',
      configRaw:
        '{"products":[],"legacyRatio":1.25,"legacyExponent":1e3,"legacyNumericText":"9007199254740993 \\" 0.1 \\\\ 1e-323"}',
    },
  ]);

  const result = await runMerchantPolicyMigration({ database });

  assert.equal(result.merchants[0].status, 'active');
  assert.deepEqual(result.merchants[0].numericSafetyIssues, []);
});

test('apply refuses missing rollback preservation and never falls back to a configured database', async () => {
  const { database, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: { products: [] } },
  ]);

  await assert.rejects(
    runMerchantPolicyMigration({ database, apply: true }),
    /rollbackSink/,
  );
  await assert.rejects(
    runMerchantPolicyMigration({ apply: true, rollbackSink: async () => {} }),
    /injected database/,
  );
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
});

test('rollback preservation failure aborts apply before any config update', async () => {
  const { database, state, calls } = makeDatabase([
    { user_id: 'merchant-apply', config: { products: [] } },
  ]);

  await assert.rejects(
    runMerchantPolicyMigration({
      database,
      apply: true,
      rollbackSink: async () => {
        throw new Error('rollback storage failed');
      },
    }),
    /rollback storage failed/,
  );

  assert.equal(state[0].config_raw, '{"products":[]}');
  assert.equal(calls.some((call) => /^UPDATE bot_configs/i.test(call.sql)), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('CLI database guard accepts loopback only and rejects hosted connection strings', () => {
  assert.equal(
    assertLocalDatabaseUrl('postgres://user:pass@127.0.0.1:5432/local'),
    'postgres://user:pass@127.0.0.1:5432/local',
  );
  assert.throws(
    () => assertLocalDatabaseUrl('postgres://user:pass@prod.railway.app:5432/main'),
    /local PostgreSQL/,
  );
});

test('CLI summary excludes full migrated and rollback configs', () => {
  const summary = summarizeMigrationResult({
    mode: 'dry-run',
    applied: 0,
    reviewIds: ['merchant-review'],
    merchants: [{
      userId: 'merchant-review',
      status: 'needs_review',
      reviewItems: [{ path: 'botInstructions', code: 'untyped_bot_instructions' }],
      migratedConfig: { openaiApiKey: 'secret-migrated' },
      rollbackConfigRaw: '{"openaiApiKey":"secret-rollback"}',
    }],
  });

  assert.deepEqual(summary, {
    mode: 'dry-run',
    applied: 0,
    reviewIds: ['merchant-review'],
    merchants: [{
      userId: 'merchant-review',
      status: 'needs_review',
      reviewItems: [{ path: 'botInstructions', code: 'untyped_bot_instructions' }],
    }],
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});

test('rollback file sink uses exclusive durable write order without touching the real filesystem', async () => {
  const calls = [];
  const fileHandle = {
    async writeFile(data, options) {
      calls.push(['writeFile', data, options]);
    },
    async sync() {
      calls.push(['file.sync']);
    },
    async close() {
      calls.push(['file.close']);
    },
  };
  const directoryHandle = {
    async sync() {
      calls.push(['directory.sync']);
    },
    async close() {
      calls.push(['directory.close']);
    },
  };
  const fsPromises = {
    async open(target, flags, mode) {
      calls.push(['open', target, flags, mode]);
      return flags === 'wx' ? fileHandle : directoryHandle;
    },
  };
  const sink = createRollbackFileSink(
    'C:\\local\\merchant-policy-rollback.json',
    { fsPromises },
  );
  const payload = {
    merchantConfigs: [{ userId: 'merchant-1', configRaw: '{"products":[]}' }],
  };

  await sink(payload);

  assert.deepEqual(calls.map((call) => call[0]), [
    'open',
    'writeFile',
    'file.sync',
    'file.close',
    'open',
    'directory.sync',
    'directory.close',
  ]);
  assert.deepEqual(calls[0], [
    'open',
    'C:\\local\\merchant-policy-rollback.json',
    'wx',
    0o600,
  ]);
  assert.equal(calls[1][1], `${JSON.stringify(payload, null, 2)}\n`);
  assert.equal(calls[1][2], 'utf8');
  assert.deepEqual(calls[4], ['open', 'C:\\local', 'r', undefined]);
});
