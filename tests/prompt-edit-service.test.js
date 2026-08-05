'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363111@g.us';

// Fake DB serving a scripted config + optional active session row. `pending`,
// when given, is the active session (include a `stage`, e.g. 'confirm').
function fakeDb({ config = {}, pending = null, threadTargets = [] } = {}) {
  const writes = [];
  const targetDigits = threadTargets.map((j) => String(j).replace(/@.*$/, '').replace(/\D/g, ''));
  return {
    writes,
    isConfigured: () => true,
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config }] };
      if (/FROM escalation_threads/.test(sql)) {
        return { rows: targetDigits.includes(String(params[1])) ? [{ ok: 1 }] : [] };
      }
      if (/SELECT[\s\S]*FROM prompt_edit_requests[\s\S]*status = 'pending'/.test(sql)) {
        return { rows: pending ? [pending] : [] };
      }
      if (/INSERT INTO prompt_edit_requests/.test(sql)) return { rows: [{ id: 'pe-1' }] };
      // markTerminalAtomic — claims the flip only while pending.
      if (/UPDATE prompt_edit_requests SET status = \$2[\s\S]*status = 'pending' RETURNING id/.test(sql)) {
        return { rows: [{ id: params[0] }] };
      }
      if (/UPDATE prompt_edit_requests/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/UPDATE bot_configs/.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    },
  };
}

function fakeAi(intent = 'other') {
  return {
    proposePromptEdit: async () => ({ newInstructions: 'الجديد الكامل', summary: 'إضافة معلومة' }),
    planConfigEdit: async () => ({ target: 'prompt' }),
    classifyReplyIntent: async () => intent,
  };
}

function makeDeps(over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      database: over.database || fakeDb(),
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => over.ai || fakeAi(over.intent),
      now: () => 1_000_000,
      ttlMinutes: 10,
    },
  };
}

const CONFIG_WITH_GROUP = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  botInstructions: 'تعليمات حالية طويلة كفاية لتكون البرومنت كامل بدون أي مشاكل إطلاقاً ووو',
};
const confirmPending = (over = {}) => ({
  id: 'pe-1', stage: 'confirm', target: 'prompt',
  proposed_instructions: 'النص النهائي', change_summary: 'تغيير',
  created_at: new Date(1_000_000 - 1000).toISOString(), ...over,
});

// ── Pure gates ────────────────────────────────────────────────────────────────
test('groupMatchesEscalation matches a configured group jid (suffix-insensitive)', () => {
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, GROUP), true);
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, '120363111'), true);
  assert.equal(svc.groupMatchesEscalation(CONFIG_WITH_GROUP, '999@g.us'), false);
  assert.equal(svc.groupMatchesEscalation({ escalationContacts: [] }, GROUP), false);
});

test('isEnabled defaults to true and respects an explicit false', () => {
  assert.equal(svc.isEnabled({}), true);
  assert.equal(svc.isEnabled({ whatsappPromptEditEnabled: false }), false);
  assert.equal(svc.isEnabled({ whatsappPromptEditEnabled: true }), true);
});

// ── Menu open ─────────────────────────────────────────────────────────────────
test('an edit trigger opens the section menu (no AI call, systemNotice send)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  let aiCalled = 0;
  const { sent, deps } = makeDeps({
    database: db,
    ai: { proposePromptEdit: async () => { aiCalled++; return {}; }, planConfigEdit: async () => null, classifyReplyIntent: async () => 'other' },
  });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, author: '96650@x', body: 'تعديل: أضف شي' } });
  assert.equal(res.promptEdit, 'menu');
  assert.equal(aiCalled, 0, 'opening the menu must not call the AI');
  assert.ok(db.writes.some((w) => /INSERT INTO prompt_edit_requests/.test(w.sql)), 'session row inserted');
  assert.equal(sent[0].sender, GROUP);
  assert.equal(sent[0].systemNotice, true, 'control message bypasses quota (not billable)');
  assert.match(sent[0].reply, /وش تبي تعدّل/);
});

// ── Confirm-stage behaviours (still valid under the state machine) ───────────
test('نعم on a confirm-stage session applies to bot_configs and announces', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'نعم' } });
  assert.equal(res.promptEdit, 'applied');
  assert.ok(db.writes.some((w) => /UPDATE bot_configs/.test(w.sql)), 'config updated');
  assert.ok(db.writes.some((w) => /UPDATE prompt_edit_requests SET status = \$2/.test(w.sql) && w.params.includes('applied')));
  assert.match(sent[sent.length - 1].reply, /تم الحفظ/);
});

test('لا on a confirm-stage session rejects it, no config write', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'لا' } });
  assert.equal(res.promptEdit, 'rejected');
  assert.ok(!db.writes.some((w) => /UPDATE bot_configs/.test(w.sql)), 'config NOT updated');
});

test('a short unrecognized confirm reply re-prompts (does not go silent)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { sent, deps } = makeDeps({ database: db, intent: 'other' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'الو' } });
  assert.equal(res.promptEdit, 'reprompt');
  assert.match(sent[0].reply, /بانتظار التأكيد/);
});

test('a LONG unrecognized sentence during confirm stays silent (team chatter)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'يا شباب لا تنسون ترسلون طلب الدفع للعميل اليوم قبل المغرب' } });
  assert.equal(res, null);
  assert.equal(sent.length, 0);
});

test('an unusual confirmation is applied via AI intent classification', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { deps } = makeDeps({ database: db, intent: 'confirm' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'ثبتها وخلاص' } });
  assert.equal(res.promptEdit, 'applied');
  assert.ok(db.writes.some((w) => /UPDATE bot_configs/.test(w.sql)));
});

test('an unusual cancellation is rejected via AI intent classification', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const { deps } = makeDeps({ database: db, intent: 'cancel' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'خلها زي ماهي بلا تغيير' } });
  assert.equal(res.promptEdit, 'rejected');
  assert.ok(!db.writes.some((w) => /UPDATE bot_configs/.test(w.sql)));
});

// ── Idempotency ──────────────────────────────────────────────────────────────
function claimStub() {
  const seen = new Set();
  return async (_db, userId, messageId) => {
    const k = `${userId}::${messageId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
}

test('a RE-DELIVERED trigger does not open the menu twice (idempotent)', async () => {
  const claimGroupAction = claimStub();
  const msg = { from: GROUP, author: '96650@x', body: 'تعديل', id: { _serialized: 'EDIT_1' } };
  const d1 = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP }) });
  assert.equal((await svc.tryHandle({ ...d1.deps, claimGroupAction, userId: 'u1', msg })).promptEdit, 'menu');
  const d2 = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP }) });
  const r2 = await svc.tryHandle({ ...d2.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r2.promptEdit, 'duplicate');
  assert.equal(d2.sent.length, 0);
});

test('a RE-DELIVERED نعم does not apply the edit twice', async () => {
  const claimGroupAction = claimStub();
  const msg = { from: GROUP, body: 'نعم', id: { _serialized: 'YES_1' } };
  const d1 = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() }) });
  assert.equal((await svc.tryHandle({ ...d1.deps, claimGroupAction, userId: 'u1', msg })).promptEdit, 'applied');
  const db2 = fakeDb({ config: CONFIG_WITH_GROUP, pending: confirmPending() });
  const d2 = makeDeps({ database: db2 });
  const r2 = await svc.tryHandle({ ...d2.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r2.promptEdit, 'duplicate');
  assert.ok(!db2.writes.some((w) => /UPDATE bot_configs/.test(w.sql)), 'config NOT written a second time');
});

// ── Gates ────────────────────────────────────────────────────────────────────
test('returns null for a non-command message with no active session', async () => {
  const { deps } = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP }) });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'صباح الخير' } });
  assert.equal(res, null);
});

test('an action-word chatter message ("احذف الرسالة القديمة") does NOT open the menu', async () => {
  const { sent, deps } = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP }) });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'احذف الرسالة القديمة يا شباب' } });
  assert.equal(res, null);
  assert.equal(sent.length, 0, 'no menu popped from normal chatter');
});

test('returns null when feature disabled, even for a trigger', async () => {
  const { deps } = makeDeps({ database: fakeDb({ config: { ...CONFIG_WITH_GROUP, whatsappPromptEditEnabled: false } }) });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل' } });
  assert.equal(res, null);
});

test('returns null when the group is not an escalation group', async () => {
  const { deps } = makeDeps({ database: fakeDb({ config: CONFIG_WITH_GROUP }) });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: '777@g.us', body: 'تعديل' } });
  assert.equal(res, null);
});

// Root cause (production 2026-07-01): recognize the group via escalation_threads
// even when escalationContacts holds descriptive text, not the JID.
test('recognizes the group via escalation_threads even when escalationContacts lacks it', async () => {
  const config = {
    escalationContacts: [{ name: 'محمد شاهيني', phone: 'متجر ProStoree خدمة عملاء' }],
    botInstructions: 'أنت موظف خدمة عملاء لمتجر ProStoree. ساعات العمل ٩ص-٩م.',
  };
  const db = fakeDb({ config, threadTargets: [GROUP] });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, author: '96650@x', body: 'تعديل' } });
  assert.equal(res.promptEdit, 'menu', 'group recognized via escalation_threads');
  assert.equal(sent[0].sender, GROUP);
});
