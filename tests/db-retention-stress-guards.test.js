'use strict';

// Verifies the stress harness is SAFE by default: it never touches a database
// without STRESS_DATABASE_URL and refuses any production-looking URL. (The heavy
// large-data run itself executes only on a disposable staging DB.)

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRetentionStress, looksLikeProd } = require('../scripts/stress/db-retention-stress');

test('skips (no DB connection) when STRESS_DATABASE_URL is unset', async () => {
  let poolMade = false;
  const res = await runRetentionStress({ env: {}, makePool: () => { poolMade = true; return {}; }, log: () => {} });
  assert.equal(res.skipped, 'no STRESS_DATABASE_URL');
  assert.equal(poolMade, false, 'must not open any pool without a stress DB URL');
});

test('refuses to run against a production-looking URL', async () => {
  let poolMade = false;
  await assert.rejects(
    () => runRetentionStress({ env: { STRESS_DATABASE_URL: 'postgres://u:p@db.jwap.net/prod' }, makePool: () => { poolMade = true; return {}; }, log: () => {} }),
    /production-looking/,
  );
  assert.equal(poolMade, false);
});

test('looksLikeProd flags prod signatures, allows a disposable local URL', () => {
  assert.equal(looksLikeProd('postgres://x@railway.app/db'), true);
  assert.equal(looksLikeProd('postgres://x@host/production'), true);
  assert.equal(looksLikeProd('postgres://x@db.jwap.net/x'), true);
  assert.equal(looksLikeProd('postgres://x@127.0.0.1:5433/stress_scratch'), false);
});
