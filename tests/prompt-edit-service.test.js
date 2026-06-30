'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/prompt-edit/prompt-edit.service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const GROUP = '120363111@g.us';

// Minimal fake DB that records writes and serves a scripted config + pending row.
function fakeDb({ config = {}, pending = null } = {}) {
  const writes = [];
  return {
    writes,
    isConfigured: () => true,
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (/FROM bot_configs/.test(sql)) return { rows: [{ config }] };
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

function fakeAi(out) {
  return { proposePromptEdit: async () => out };
}

function makeDeps(over = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      database: over.database || fakeDb(),
      logger: silentLogger,
      enqueue: async (p) => { sent.push(p); },
      buildAiClient: async () => over.ai || fakeAi({ newInstructions: 'الجديد الكامل', summary: 'إضافة معلومة' }),
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
  assert.match(sent[0].reply, /إضافة معلومة/);
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
