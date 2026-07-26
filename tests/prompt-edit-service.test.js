'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');
const { canonicalConfig } = require('./helpers/canonical-config');

const GROUP = '120363111@g.us';
const CONFIG = canonicalConfig({
  contacts: [{ id: 'team', name: 'الفريق', phoneNumber: '+120363111' }],
  operational: { whatsappPromptEditEnabled: true },
});

function fakeDb({ config = CONFIG, pending = null, knownGroup = false } = {}) {
  const writes = [];
  return {
    writes,
    isConfigured: () => true,
    async query(sql, params = []) {
      writes.push({ sql, params });
      if (/SELECT config FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: knownGroup ? [{ ok: 1 }] : [] };
      if (/FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        return { rows: pending ? [pending] : [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      if (/UPDATE prompt_edit_requests/.test(sql)) return { rows: [] };
      if (/UPDATE bot_configs/.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    },
  };
}

function deps(database) {
  const sent = [];
  return {
    sent,
    value: {
      database,
      userId: 'u1',
      enqueue: async payload => sent.push(payload),
      logger: { info() {}, warn() {}, error() {} },
      now: () => 1_000_000,
      ttlMinutes: 10,
    },
  };
}

test('group matching uses only canonical policy contacts', () => {
  assert.equal(svc.groupMatchesEscalation(CONFIG, GROUP), true);
  assert.equal(svc.groupMatchesEscalation({ escalationContacts: [{ phone: GROUP }] }, GROUP), false);
});

test('untyped edit is stored for review and never activates facts', async () => {
  const database = fakeDb();
  const h = deps(database);
  const result = await svc.tryHandle({
    ...h.value,
    msg: { from: GROUP, author: '96650@s.whatsapp.net', body: 'تعديل: السعر 99' },
  });
  assert.equal(result.promptEdit, 'needs_review');
  assert.ok(database.writes.some(write => /INSERT INTO prompt_edit_requests/.test(write.sql)));
  assert.ok(!database.writes.some(write => /UPDATE bot_configs/.test(write.sql)));
  assert.match(h.sent[0].policyVersion, /^sha256:/);
});

test('confirming an untyped pending request marks needs_review without a policy write', async () => {
  const pending = {
    id: 'pe-1',
    target: 'merchant_policy_review',
    created_at: new Date(999_000).toISOString(),
  };
  const database = fakeDb({ pending });
  const h = deps(database);
  const result = await svc.tryHandle({ ...h.value, msg: { from: GROUP, body: 'نعم' } });
  assert.equal(result.promptEdit, 'needs_review');
  assert.ok(database.writes.some(write => write.params?.includes('needs_review')));
  assert.ok(!database.writes.some(write => /UPDATE bot_configs/.test(write.sql)));
});

test('rejecting a pending request never changes policy', async () => {
  const pending = { id: 'pe-1', created_at: new Date(999_000).toISOString() };
  const database = fakeDb({ pending });
  const h = deps(database);
  const result = await svc.tryHandle({ ...h.value, msg: { from: GROUP, body: 'لا' } });
  assert.equal(result.promptEdit, 'rejected');
  assert.ok(!database.writes.some(write => /UPDATE bot_configs/.test(write.sql)));
});

test('known escalation thread may authorize the admin group, but not its facts', async () => {
  const database = fakeDb({ config: canonicalConfig(), knownGroup: true });
  const h = deps(database);
  const result = await svc.tryHandle({
    ...h.value,
    msg: { from: GROUP, body: 'تعديل: أضف ضمان سنة' },
  });
  assert.equal(result.promptEdit, 'needs_review');
  assert.ok(!database.writes.some(write => /UPDATE bot_configs/.test(write.sql)));
});

test('canonical writer derives policy version and rejects every legacy field', async () => {
  const database = fakeDb();
  const candidate = canonicalConfig().merchantPolicy;
  const compiled = await svc.applySectionValue(database, 'u1', 'merchantPolicy', candidate);
  assert.match(compiled.policyVersion, /^sha256:/);
  await assert.rejects(
    svc.applySectionValue(database, 'u1', 'products', []),
    error => error.code === 'NON_CANONICAL_POLICY_WRITE',
  );
});

test('free-form instruction writer is permanently fail-closed', async () => {
  await assert.rejects(
    svc.applyInstructions(null, 'u1', 'سعر المنتج 99'),
    error => error.code === 'UNTYPED_POLICY_EDIT_REQUIRES_REVIEW',
  );
});
