'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const matrix = require('../tests/fixtures/simulation-critical-matrix.json');
const {
  automatedRequest,
  compiledPolicy,
  createHarness,
  merchantPolicy,
} = require('../tests/helpers/deterministic-runtime-harness');
const { validateAutomatedReply } = require('../src/services/ai/deterministic-reply-validator');
const { buildDeterministicFallback } = require('../src/services/ai/deterministic-fallback');
const { PLATFORM_REPLY_POLICY } = require('../src/policy/platform-reply-policy');

function twoProductPolicy() {
  const value = merchantPolicy({ productName: 'Alpha', priceMinor: 10000 });
  value.catalog.products.push({
    id: 'product-2',
    name: 'Beta',
    aliases: [],
    description: '',
    links: [],
    attributes: {},
    variants: [{
      id: 'variant-2',
      name: 'Standard',
      price: { amountMinor: 20000, currency: 'SAR' },
      duration: null,
      availability: null,
      attributes: {},
    }],
  });
  return compiledPolicy(value);
}

function merchantRequest(sendClass, content, compiled, suffix) {
  return {
    sendClass,
    userId: 'tenant-1',
    channelId: 'whatsapp',
    destination: '966500000001@s.whatsapp.net',
    idempotencyKey: `${sendClass}:${suffix}`,
    correlationId: `${sendClass}:${suffix}`,
    content,
    contentOrigin: sendClass,
    policyVersion: compiled.policyVersion,
    tenantScope: { userId: 'tenant-1' },
  };
}

async function expectRejected(promise, pattern) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(String(error.message), pattern);
}

async function executeCase(caseId, iteration) {
  const destination = '966500000001@s.whatsapp.net';
  const userId = 'tenant-1';
  const compiled = twoProductPolicy();
  const baseOptions = {
    policies: new Map([[userId, compiled.policy]]),
    destinationOwners: new Map([[destination, userId]]),
  };

  if (caseId === 'valid-canonical-reply') {
    const harness = createHarness(baseOptions);
    const result = await harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `valid:${iteration}`,
    }));
    assert.equal(result.decision, 'sent');
    assert.equal(harness.sends.length, 1);
    return;
  }
  if (caseId === 'cross-product-number') {
    const result = validateAutomatedReply({
      customerText: 'What does Beta cost?',
      conversationFocus: {
        productId: 'product-2',
        variantId: 'variant-2',
        topics: ['price'],
        evidenceRefs: ['product-2'],
      },
      reply: 'Beta costs 100 SAR',
      compiledPolicy: compiled,
      platformPolicy: PLATFORM_REPLY_POLICY,
    });
    assert.equal(result.ok, false);
    return;
  }
  if (caseId === 'unauthorized-contact') {
    const result = validateAutomatedReply({
      customerText: 'Hello',
      conversationFocus: { topics: ['greeting'], evidenceRefs: [] },
      reply: 'Call 0593216744',
      compiledPolicy: compiled,
      platformPolicy: PLATFORM_REPLY_POLICY,
    });
    assert.equal(result.violations.some(item => item.code === 'UNAUTHORIZED_CONTACT'), true);
    return;
  }
  if (caseId === 'safe-fallback') {
    const fallback = buildDeterministicFallback({
      customerText: 'I need details',
      conversationFocus: {},
      compiledPolicy: compiled,
      platformPolicy: PLATFORM_REPLY_POLICY,
    });
    assert.doesNotMatch(fallback.reply, /\d|https?:|SAR|ريال|ضمان|خصم|متاح/iu);
    return;
  }
  if (caseId === 'missing-policy') {
    const harness = createHarness({
      destinationOwners: new Map([[destination, userId]]),
    });
    await expectRejected(harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `missing:${iteration}`,
    })), /POLICY_MISSING/);
    assert.equal(harness.sends.length, 0);
    return;
  }
  if (caseId === 'stale-policy') {
    const latest = compiledPolicy(merchantPolicy({ productName: 'Alpha', priceMinor: 30000 }));
    const harness = createHarness({
      policies: new Map([[userId, latest.policy]]),
      destinationOwners: new Map([[destination, userId]]),
    });
    await expectRejected(harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `stale:${iteration}`,
    })), /POLICY_VERSION_MISMATCH/);
    assert.equal(harness.sends.length, 0);
    return;
  }
  if (caseId === 'duplicate-job') {
    const harness = createHarness(baseOptions);
    const request = automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `duplicate:${iteration}`,
    });
    await harness.gateway.send(request);
    const duplicate = await harness.gateway.send(request);
    assert.equal(duplicate.decision, 'duplicate');
    assert.equal(harness.sends.length, 1);
    return;
  }
  if (caseId === 'tenant-mismatch') {
    const harness = createHarness({
      policies: new Map([[userId, compiled.policy]]),
      destinationOwners: new Map([[destination, 'tenant-2']]),
    });
    await expectRejected(harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `tenant:${iteration}`,
    })), /DESTINATION_SCOPE_MISMATCH/);
    assert.equal(harness.sends.length, 0);
    return;
  }
  if (caseId === 'database-failure') {
    const harness = createHarness({ ...baseOptions, failureAt: 'policy' });
    await expectRejected(harness.gateway.send(automatedRequest({
      userId,
      destination,
      policyVersion: compiled.policyVersion,
      idempotencyKey: `db:${iteration}`,
    })), /INJECTED_policy/);
    assert.equal(harness.sends.length, 0);
    return;
  }
  if (caseId === 'human-byte-preservation' || caseId === 'campaign-byte-preservation') {
    const sendClass = caseId.startsWith('human') ? 'human_manual_reply' : 'campaign';
    const content = `  exact bytes ${iteration}\nline two  `;
    const harness = createHarness(baseOptions);
    await harness.gateway.send(merchantRequest(sendClass, content, compiled, iteration));
    assert.equal(harness.sends[0].content, content);
    return;
  }
  if (caseId === 'platform-policy-version') {
    const harness = createHarness(baseOptions);
    const request = {
      ...merchantRequest('platform_alert', 'Internal alert', compiled, iteration),
      policyVersion: compiled.policyVersion,
    };
    await expectRejected(harness.gateway.send(request), /POLICY_VERSION_MISMATCH/);
    assert.equal(harness.sends.length, 0);
    return;
  }
  throw new Error(`unknown simulation case: ${caseId}`);
}

async function runSimulation({
  seed = matrix.seed,
  sequences = matrix.minimumSequences,
  reportPath = null,
} = {}) {
  if (!Number.isInteger(sequences) || sequences < matrix.minimumSequences) {
    throw new Error(`sequences must be at least ${matrix.minimumSequences}`);
  }
  const coverage = Object.fromEntries(matrix.cases.map(item => [item.id, 0]));
  for (let index = 0; index < sequences; index += 1) {
    const item = matrix.cases[(index + seed) % matrix.cases.length];
    await executeCase(item.id, index);
    coverage[item.id] += 1;
  }
  for (const item of matrix.cases) assert.ok(coverage[item.id] > 0);
  const report = {
    generatedAt: new Date().toISOString(),
    seed,
    sequences,
    networkDependencies: 0,
    assertions: sequences,
    criticalCases: matrix.cases.length,
    coverage,
    status: 'passed',
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function cliArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--seed') result.seed = Number(argv[++index]);
    else if (argv[index] === '--sequences') result.sequences = Number(argv[++index]);
    else if (argv[index] === '--report') result.reportPath = path.resolve(argv[++index]);
  }
  return result;
}

if (require.main === module) {
  runSimulation(cliArgs(process.argv.slice(2)))
    .then(report => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = { runSimulation };
