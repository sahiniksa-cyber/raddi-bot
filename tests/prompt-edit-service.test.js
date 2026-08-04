'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363111@g.us';

// Minimal fake DB that records writes and serves a scripted config + pending row.
// threadTargets: group JIDs the bot has escalated to (escalation_threads ground truth).
function fakeDb({ config = {}, pending = null, threadTargets = [] } = {}) {
  const writes = [];
  const targetDigits = threadTargets.map(j => String(j).replace(/@.*$/, '').replace(/\D/g, ''));
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
      if (/UPDATE prompt_edit_requests/.test(sql)) return { rows: [{ id: params[0] }] };
      if (/UPDATE bot_configs/.test(sql)) return { rowCount: 1 };
      if (/SELECT[\s\S]*FROM prompt_edit_requests/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function fakeAi(out, intent = 'other') {
  return { proposePromptEdit: async () => out, classifyReplyIntent: async () => intent };
}

function makeDeps(over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      database: over.database || fakeDb(),
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => over.ai || fakeAi({ newInstructions: 'الجديد الكامل', summary: 'إضافة معلومة' }, over.intent || 'other'),
      now: () => 1_000_000,
      ttlMinutes: 10,
      ...over.deps,
    },
  };
}

const CONFIG_WITH_GROUP = {
  escalationContacts: [{ name: 'الفريق', phone: GROUP }],
  botInstructions: 'تعليمات حالية طويلة كفاية لتكون البرومنت كامل بدون أي مشاكل إطلاقاً ووو',
};

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

test('tryHandle: an edit command proposes a change, stores pending, replies a summary, no customer send', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({
    ...deps,
    userId: 'u1',
    msg: { from: GROUP, author: '96650@s.whatsapp.net', body: 'تعديل: أضف إننا نوصل للرياض مجاناً' },
  });
  assert.equal(res.promptEdit, 'proposed');
  assert.ok(db.writes.some(w => /INSERT INTO prompt_edit_requests/.test(w.sql)), 'pending row inserted');
  assert.equal(sent.length, 1, 'one summary message sent to the group');
  assert.equal(sent[0].sender, GROUP);
  assert.equal(sent[0].systemNotice, true, 'control message must bypass quota (not billable, not blocked when empty)');
  assert.match(sent[0].reply, /إضافة معلومة/);
});

// A claim stub that dedups by (userId, messageId): first call true, then false.
function claimStub() {
  const seen = new Set();
  const fn = async (_db, userId, messageId) => {
    const k = `${userId}::${messageId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return fn;
}

test('tryHandle: a RE-DELIVERED edit command does not propose twice (idempotent)', async () => {
  const claimGroupAction = claimStub();
  const msg = { from: GROUP, author: '96650@s.whatsapp.net', body: 'تعديل: أضف إننا نوصل للرياض مجاناً', id: { _serialized: 'EDIT_MSG_1' } };

  const db1 = fakeDb({ config: CONFIG_WITH_GROUP });
  const d1 = makeDeps({ database: db1 });
  const r1 = await svc.tryHandle({ ...d1.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r1.promptEdit, 'proposed');
  assert.equal(d1.sent.length, 1);

  // Same message id arrives again (WhatsApp re-sync) → must be a silent no-op.
  const db2 = fakeDb({ config: CONFIG_WITH_GROUP });
  const d2 = makeDeps({ database: db2 });
  const r2 = await svc.tryHandle({ ...d2.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r2.promptEdit, 'duplicate');
  assert.equal(d2.sent.length, 0, 'no second proposal sent');
  assert.ok(!db2.writes.some(w => /INSERT INTO prompt_edit_requests/.test(w.sql)), 'no second pending inserted');
});

test('tryHandle: a RE-DELIVERED نعم does not apply the edit twice', async () => {
  const claimGroupAction = claimStub();
  const pending = { id: 'pe-1', proposed_instructions: 'النص النهائي', change_summary: 'تغيير', created_at: new Date(1_000_000 - 1000).toISOString() };
  const msg = { from: GROUP, body: 'نعم', id: { _serialized: 'YES_MSG_1' } };

  const db1 = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const d1 = makeDeps({ database: db1 });
  const r1 = await svc.tryHandle({ ...d1.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r1.promptEdit, 'applied');

  const db2 = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const d2 = makeDeps({ database: db2 });
  const r2 = await svc.tryHandle({ ...d2.deps, claimGroupAction, userId: 'u1', msg });
  assert.equal(r2.promptEdit, 'duplicate');
  assert.ok(!db2.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config NOT written a second time');
  assert.equal(d2.sent.length, 0, 'no second confirmation sent');
});

test('tryHandle: نعم with a pending edit applies it to bot_configs and confirms', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'النص النهائي', change_summary: 'تغيير', created_at: new Date(1_000_000 - 1000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'نعم' } });
  assert.equal(res.promptEdit, 'applied');
  assert.ok(db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config updated');
  assert.ok(db.writes.some(w => /UPDATE prompt_edit_requests/.test(w.sql) && w.params.includes('applied')));
  assert.match(sent[0].reply, /تم/);
});

test('tryHandle: لا with a pending edit rejects it, no config write', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'لا' } });
  assert.equal(res.promptEdit, 'rejected');
  assert.ok(!db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config NOT updated');
});

test('tryHandle: returns null for a non-command message in the group (falls through)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'صباح الخير' } });
  assert.equal(res, null);
});

// Production 2026-07-02: after an unrecognized reply the bot went silent and the
// merchant typed "الو"; a pending edit should be re-prompted (not canceled, not
// silent) for SHORT unrecognized replies.
test('tryHandle: short unrecognized reply while a pending edit exists re-prompts (does not cancel)', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'الو' } });
  assert.equal(res.promptEdit, 'reprompt');
  assert.ok(!db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config not changed');
  assert.ok(!db.writes.some(w => /UPDATE prompt_edit_requests/.test(w.sql)), 'pending not resolved');
  assert.match(sent[0].reply, /بانتظار التأكيد|نعم|لا/);
});

test('tryHandle: a LONG unrecognized sentence while pending does NOT re-prompt (stays silent to avoid spam)', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'يا شباب لا تنسون ترسلون طلب الدفع للعميل اليوم قبل المغرب' } });
  assert.equal(res, null);
  assert.equal(sent.length, 0);
});

// The merchant wants ANY confirmation wording to work — not a fixed keyword.
// Unusual phrasings are classified by the AI (confirm/cancel/other).
test('tryHandle: an unusual confirmation ("ثبتها") is applied via AI intent classification', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'النص النهائي', change_summary: 'x', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db, intent: 'confirm' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'ثبتها وخلاص' } });
  assert.equal(res.promptEdit, 'applied');
  assert.ok(db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config updated via AI-understood confirm');
});

test('tryHandle: an unusual cancellation is rejected via AI intent classification', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { deps } = makeDeps({ database: db, intent: 'cancel' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'خلها زي ماهي بلا تغيير' } });
  assert.equal(res.promptEdit, 'rejected');
  assert.ok(!db.writes.some(w => /UPDATE bot_configs/.test(w.sql)), 'config not changed on cancel');
});

test('tryHandle: AI says "other" for a short reply -> re-prompt, no apply/cancel', async () => {
  const pending = { id: 'pe-1', proposed_instructions: 'x', change_summary: 'y', created_at: new Date(1_000_000).toISOString() };
  const db = fakeDb({ config: CONFIG_WITH_GROUP, pending });
  const { sent, deps } = makeDeps({ database: db, intent: 'other' });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'الو' } });
  assert.equal(res.promptEdit, 'reprompt');
  assert.ok(!db.writes.some(w => /UPDATE bot_configs/.test(w.sql)));
  assert.match(sent[0].reply, /بانتظار التأكيد/);
});

test('tryHandle: returns null when feature disabled, even for an edit command', async () => {
  const db = fakeDb({ config: { ...CONFIG_WITH_GROUP, whatsappPromptEditEnabled: false } });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل: شيء' } });
  assert.equal(res, null);
});

test('tryHandle: returns null when the group is not a configured escalation group', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const { deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: '777@g.us', body: 'تعديل: شيء' } });
  assert.equal(res, null);
});

// ROOT CAUSE (production 2026-07-01): the bot escalates to a GROUP recorded in
// escalation_threads, but escalationContacts holds descriptive text — not the
// group JID. Group identification MUST also trust escalation_threads (the real
// destination), not only config. Without the fix this returns null (silent).
test('tryHandle: recognizes the group via escalation_threads even when escalationContacts lacks it', async () => {
  const config = {
    escalationContacts: [{ name: 'محمد شاهيني', phone: 'متجر ProStoree خدمة عملاء' }], // NOT a jid
    botInstructions: 'أنت موظف خدمة عملاء لمتجر ProStoree. ساعات العمل ٩ص-٩م بدون أي مشاكل.',
  };
  const db = fakeDb({ config, threadTargets: [GROUP] }); // bot HAS escalated to GROUP
  const { sent, deps } = makeDeps({ database: db });
  const res = await svc.tryHandle({
    ...deps, userId: 'u1',
    msg: { from: GROUP, author: '96650@s.whatsapp.net', body: 'ضيف في البرومنت: لو سأل عن اشتراك ادوبي قول مضمون' },
  });
  assert.equal(res.promptEdit, 'proposed', 'group recognized via escalation_threads');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sender, GROUP);
});

test('tryHandle: a lone keyword asks the user to write the change (handled, no AI call)', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  let aiCalled = 0;
  const { sent, deps } = makeDeps({ database: db, ai: { proposePromptEdit: async () => { aiCalled++; return {}; } } });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل' } });
  assert.equal(res.promptEdit, 'help');
  assert.equal(aiCalled, 0);
  assert.match(sent[0].reply, /اكتب التعديل|بعد كلمة/);
});

test('tryHandle: model failure sends a clear error and does not store a pending row', async () => {
  const db = fakeDb({ config: CONFIG_WITH_GROUP });
  const failingAi = { proposePromptEdit: async () => { throw new Error('boom'); } };
  const { sent, deps } = makeDeps({ database: db, ai: failingAi });
  const res = await svc.tryHandle({ ...deps, userId: 'u1', msg: { from: GROUP, body: 'تعديل: شيء غامض' } });
  assert.equal(res.promptEdit, 'error');
  assert.ok(!db.writes.some(w => /INSERT INTO prompt_edit_requests/.test(w.sql)));
  assert.match(sent[0].reply, /ما قدرت أفهم|جرّب/);
});
