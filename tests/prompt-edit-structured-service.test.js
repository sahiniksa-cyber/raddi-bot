'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363@g.us';
const CONFIG = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  products: [{ name: 'اشتراك أدوبي', price: '80', description: 'تصميم' }],
  autoReplyKeywords: {},
  doNotReplyList: [],
};

function fakeDb() {
  const writes = [];
  return {
    writes,
    isConfigured: () => true,
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config: CONFIG }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/status = 'pending'/.test(sql)) return { rows: [] };
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      return { rows: [] };
    },
  };
}

function deps(planObj, database) {
  const sent = [];
  return {
    sent,
    d: {
      database,
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => ({
        planConfigEdit: async () => planObj,
        proposePromptEdit: async () => ({ newInstructions: 'x', summary: 'y' }),
        classifyReplyIntent: async () => 'other',
      }),
      now: () => 1_000_000,
      ttlMinutes: 10,
    },
  };
}

test('a product-price command stores a pending edit with target=products and the new products value', async () => {
  const db = fakeDb();
  const { sent, d } = deps({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '99' }, summary: 'تحديث سعر أدوبي إلى 99' }, db);
  const res = await svc.tryHandle({ ...d, userId: 'u1', msg: { from: GROUP, body: 'غيّر سعر أدوبي إلى 99' } });
  assert.equal(res.promptEdit, 'proposed');
  const ins = db.writes.find((w) => /INSERT INTO prompt_edit_requests/.test(w.sql));
  assert.ok(ins, 'pending inserted');
  assert.ok(ins.params.includes('products'), 'target=products stored');
  const pv = ins.params.find((x) => typeof x === 'string' && x.includes('"price":"99"'));
  assert.ok(pv, 'proposed_value contains the updated price');
  assert.match(sent[0].reply, /تحديث سعر أدوبي/);
});

test('a clarify plan asks the merchant and stores no pending', async () => {
  const db = fakeDb();
  const { sent, d } = deps({ target: 'products', action: 'update', clarify: 'أي منتج تقصد؟' }, db);
  const res = await svc.tryHandle({ ...d, userId: 'u1', msg: { from: GROUP, body: 'غيّر السعر' } });
  assert.equal(res.promptEdit, 'clarify');
  assert.ok(!db.writes.some((w) => /INSERT INTO prompt_edit_requests/.test(w.sql)));
  assert.match(sent[0].reply, /أي منتج/);
});

test('an applier validation error is reported, no pending', async () => {
  const db = fakeDb();
  const { d } = deps({ target: 'do_not_reply', action: 'add', number: 'abc' }, db);
  const res = await svc.tryHandle({ ...d, userId: 'u1', msg: { from: GROUP, body: 'احظر abc' } });
  assert.equal(res.promptEdit, 'error');
  assert.ok(!db.writes.some((w) => /INSERT INTO prompt_edit_requests/.test(w.sql)));
});

test('an explicit "برومنت" command skips classification and goes to the prompt path', async () => {
  const db = fakeDb();
  // planConfigEdit would (wrongly) say products, but forcePrompt must bypass it.
  const { sent, d } = deps({ target: 'products', action: 'update', product: { name: 'اشتراك أدوبي', price: '1' }, summary: 'خطأ' }, db);
  const res = await svc.tryHandle({ ...d, userId: 'u1', msg: { from: GROUP, body: 'برومنت لو سأل عن سعر أدوبي قول مضمون' } });
  assert.equal(res.promptEdit, 'proposed');
  const ins = db.writes.find((w) => /INSERT INTO prompt_edit_requests/.test(w.sql));
  assert.ok(ins.params.includes('prompt'), 'stored as a prompt edit, not products');
});

test('confirming a structured pending writes proposed_value to the target field', async () => {
  const applied = [];
  const db = {
    isConfigured: () => true,
    query: async (sql, params) => {
      applied.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config: CONFIG }] };
      if (/FROM escalation_threads/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/status = 'pending'/.test(sql)) {
        return { rows: [{ id: 'pe-1', target: 'products', proposed_value: [{ name: 'اشتراك أدوبي', price: '99' }], proposed_instructions: 'تحديث', change_summary: 'تحديث سعر', created_at: new Date(1_000_000).toISOString() }] };
      }
      return { rows: [] };
    },
  };
  const { d } = deps(null, db);
  const res = await svc.tryHandle({ ...d, userId: 'u1', msg: { from: GROUP, body: 'نعم' } });
  assert.equal(res.promptEdit, 'applied');
  const upd = applied.find((w) => /UPDATE bot_configs/.test(w.sql));
  assert.ok(upd, 'config updated');
  assert.ok(upd.params.some((x) => typeof x === 'string' && x.includes('{products}')), 'wrote to the products field');
});
