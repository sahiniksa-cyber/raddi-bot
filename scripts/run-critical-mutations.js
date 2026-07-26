'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  automatedRequest,
  compiledPolicy,
  merchantPolicy,
} = require('../tests/helpers/deterministic-runtime-harness');
const { PLATFORM_REPLY_POLICY } = require('../src/policy/platform-reply-policy');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = path.join(ROOT, 'src/services/whatsapp/whatsapp-send-gateway.js');
const VALIDATOR = path.join(ROOT, 'src/services/ai/deterministic-reply-validator.js');
const POST_PROCESS = path.join(ROOT, 'lib/post-process-reply.js');

function compileMutated(filename, replacements) {
  let source = fs.readFileSync(filename, 'utf8');
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`mutation target not found in ${filename}: ${from}`);
    source = source.replace(from, to);
  }
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance._compile(source, filename);
  return instance.exports;
}

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

function gatewayFixture(exports, overrides = {}) {
  const compiled = twoProductPolicy();
  const sends = [];
  const events = [];
  const deps = {
    auditStore: {
      append: async event => {
        events.push(event);
        return event;
      },
      reserveSend: async args => ({ reserved: true, reservation: { ...args, status: 'reserved' } }),
      markReservation: async args => args,
    },
    policyStore: {
      loadMerchantPolicy: async () => compiled.policy,
    },
    scopeStore: {
      assertSendScope: async () => true,
    },
    transport: {
      send: async request => {
        sends.push(request);
        return { providerMessageId: 'mutant-provider' };
      },
    },
    platformPolicy: PLATFORM_REPLY_POLICY,
    ...overrides,
  };
  return {
    compiled,
    events,
    gateway: exports.createWhatsAppSendGateway(deps),
    sends,
  };
}

function baseRequest(compiled) {
  return automatedRequest({
    userId: 'tenant-1',
    destination: '966500000001@s.whatsapp.net',
    policyVersion: compiled.policyVersion,
    idempotencyKey: 'mutation-key',
  });
}

async function settled(promise) {
  try {
    return { result: await promise, error: null };
  } catch (error) {
    return { result: null, error };
  }
}

const MUTANTS = [
  {
    id: 'policy-required',
    file: GATEWAY,
    replacements: [["if (!policy) throw new Error('POLICY_MISSING');", "if (false) throw new Error('POLICY_MISSING');"]],
    probe: async exports => {
      const fixture = gatewayFixture(exports, {
        policyStore: { loadMerchantPolicy: async () => null },
        compilePolicy: () => twoProductPolicy(),
      });
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'policy-version-required',
    file: GATEWAY,
    replacements: [
      ["requireText(request.policyVersion, 'policyVersion');", "void request.policyVersion;"],
      ["if (compiledPolicy.policyVersion !== envelope.policyVersion) {", "if (false && compiledPolicy.policyVersion !== envelope.policyVersion) {"],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports);
      const request = baseRequest(fixture.compiled);
      delete request.policyVersion;
      await settled(fixture.gateway.send(request));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'tenant-scope',
    file: GATEWAY,
    replacements: [
      ["if (request.tenantScope.userId !== request.userId) {", "if (false && request.tenantScope.userId !== request.userId) {"],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports);
      const request = baseRequest(fixture.compiled);
      request.tenantScope = { userId: 'tenant-2' };
      await settled(fixture.gateway.send(request));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'destination-scope',
    file: GATEWAY,
    replacements: [
      ['await scopeStore.assertSendScope(envelope);', 'void envelope;'],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports, {
        scopeStore: { assertSendScope: async () => { throw new Error('DESTINATION_SCOPE_MISMATCH'); } },
      });
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'audit-before-network',
    file: GATEWAY,
    replacements: [
      ["await append(\n        envelope,\n        'authorized',", "await (async () => undefined)(\n        envelope,\n        'authorized',"],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports);
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1
        && !fixture.events.some(event => event.stage === 'authorized');
    },
  },
  {
    id: 'idempotency-reservation',
    file: GATEWAY,
    replacements: [
      ['if (!reservation.reserved) {', 'if (false && !reservation.reserved) {'],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports, {
        auditStore: {
          append: async event => event,
          reserveSend: async () => ({ reserved: false, reservation: { status: 'sent' } }),
          markReservation: async args => args,
        },
      });
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'deterministic-validation',
    file: GATEWAY,
    replacements: [
      ['if (!validation?.ok) {', 'if (false && !validation?.ok) {'],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports, {
        validator: () => ({ ok: false, evidenceRefs: [], violations: [{ code: 'MUTANT' }] }),
      });
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'fail-closed-policy-dependency',
    file: GATEWAY,
    replacements: [
      [
        'const policy = await policyStore.loadMerchantPolicy(envelope.userId);',
        'const policy = await policyStore.loadMerchantPolicy(envelope.userId).catch(() => platformPolicy);',
      ],
    ],
    probe: async exports => {
      const fixture = gatewayFixture(exports, {
        policyStore: { loadMerchantPolicy: async () => { throw new Error('DB_DOWN'); } },
        compilePolicy: () => twoProductPolicy(),
      });
      await settled(fixture.gateway.send(baseRequest(fixture.compiled)));
      return fixture.sends.length === 1;
    },
  },
  {
    id: 'product-bound-numeric-lookup',
    file: VALIDATOR,
    replacements: [
      ['if (product && focus.productId === product.id) {', 'if (product) {'],
    ],
    probe: async exports => {
      const compiled = twoProductPolicy();
      const result = exports.validateAutomatedReply({
        customerText: 'What does Beta cost?',
        conversationFocus: {
          productId: 'product-2',
          variantId: 'variant-1',
          topics: ['price'],
          evidenceRefs: ['product-1'],
        },
        reply: 'The price is 100 SAR',
        compiledPolicy: compiled,
        platformPolicy: PLATFORM_REPLY_POLICY,
      });
      return result.ok === true;
    },
  },
  {
    id: 'contact-authorization',
    file: VALIDATOR,
    replacements: [
      ["if (!allowed) addViolation('UNAUTHORIZED_CONTACT', claim);", "void allowed;"],
    ],
    probe: async exports => {
      const result = exports.validateAutomatedReply({
        customerText: 'Contact support',
        conversationFocus: { topics: ['contact'], evidenceRefs: [] },
        reply: 'Call 0593216744',
        compiledPolicy: twoProductPolicy(),
        platformPolicy: PLATFORM_REPLY_POLICY,
      });
      return !result.violations.some(item => item.code === 'UNAUTHORIZED_CONTACT');
    },
  },
  {
    id: 'current-turn-relevance',
    file: VALIDATOR,
    replacements: [
      ['if (offTopic) {', 'if (false && offTopic) {'],
    ],
    probe: async exports => {
      const result = exports.validateAutomatedReply({
        customerText: 'Is Alpha available?',
        conversationFocus: {
          productId: 'product-1',
          variantId: 'variant-1',
          topics: ['availability'],
          evidenceRefs: ['product-1'],
        },
        reply: 'Alpha costs 100 SAR',
        compiledPolicy: twoProductPolicy(),
        platformPolicy: PLATFORM_REPLY_POLICY,
      });
      return !result.violations.some(item => item.code === 'OFF_TOPIC_CURRENT_TURN');
    },
  },
  {
    id: 'forbidden-content-non-restoration',
    file: POST_PROCESS,
    replacements: [
      ["if (!cleaned) return '';", "if (!cleaned) return String(reply).trim();"],
    ],
    probe: async exports => exports.stripAvoidedContent(
      'forbidden phrase',
      { replyStyle: { avoidPhrases: ['forbidden phrase'] } },
    ) === 'forbidden phrase',
  },
];

async function runMutations({ reportPath = null } = {}) {
  const results = [];
  for (const mutant of MUTANTS) {
    let killed = false;
    let error = null;
    try {
      const exports = compileMutated(mutant.file, mutant.replacements);
      killed = await mutant.probe(exports);
    } catch (caught) {
      error = caught.stack || String(caught);
    }
    results.push({
      id: mutant.id,
      file: path.relative(ROOT, mutant.file).replaceAll('\\', '/'),
      killed,
      error,
    });
  }
  const killed = results.filter(result => result.killed).length;
  const report = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    killed,
    survivors: results.filter(result => !result.killed).map(result => result.id),
    mutationScore: results.length === 0 ? 0 : killed / results.length,
    status: killed === results.length ? 'passed' : 'failed',
    results,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.status !== 'passed') {
    const error = new Error(`critical mutants survived: ${report.survivors.join(', ')}`);
    error.report = report;
    throw error;
  }
  return report;
}

function reportArg(argv) {
  const index = argv.indexOf('--report');
  return index === -1 ? null : path.resolve(argv[index + 1]);
}

if (require.main === module) {
  runMutations({ reportPath: reportArg(process.argv.slice(2)) })
    .then(report => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(error => {
      if (error.report) process.stderr.write(`${JSON.stringify(error.report)}\n`);
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = { MUTANTS, runMutations };
