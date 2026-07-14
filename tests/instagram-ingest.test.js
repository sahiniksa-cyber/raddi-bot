'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractMessages, ingestWebhookEntry, ensureUsername } = require('../src/services/instagram/instagram-ingest');

test('extractMessages flattens entry[].messaging[] into normalized items', () => {
  const body = {
    object: 'instagram',
    entry: [{
      id: 'IGACC',
      messaging: [
        { sender: { id: 'CUST' }, recipient: { id: 'IGACC' }, timestamp: 1, message: { mid: 'm1', text: 'hello' } },
      ],
    }],
  };
  const items = extractMessages(body);
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0], {
    igAccountId: 'IGACC', participantId: 'CUST', mid: 'm1', text: 'hello', echo: false, timestamp: 1,
  });
});

test('extractMessages marks echoes and empty text (filterable)', () => {
  const body = {
    object: 'instagram',
    entry: [{
      id: 'IGACC',
      messaging: [
        { sender: { id: 'IGACC' }, recipient: { id: 'CUST' }, message: { mid: 'm2', text: 'reply', is_echo: true } },
        { sender: { id: 'CUST' }, recipient: { id: 'IGACC' }, message: { mid: 'm3' } },
      ],
    }],
  };
  const usable = extractMessages(body).filter((i) => !i.echo && i.text);
  assert.strictEqual(usable.length, 0);
});

test('extractMessages tolerates missing entry/messaging', () => {
  assert.deepStrictEqual(extractMessages({}), []);
  assert.deepStrictEqual(extractMessages({ entry: [{}] }), []);
});

test('ingestWebhookEntry stores inbound + enqueues AI once', async () => {
  const calls = { insertConv: 0, insertMsg: 0, enqueue: 0 };
  const database = {
    query: async (sql) => {
      if (sql.includes('INSERT INTO instagram_conversations')) { calls.insertConv++; return { rows: [{ id: 'conv1', ai_paused: false }] }; }
      if (sql.includes('INSERT INTO instagram_messages')) { calls.insertMsg++; return { rows: [{ id: 'msg1' }] }; }
      return { rows: [] };
    },
  };
  const enqueueAi = async () => { calls.enqueue++; };
  const item = { igAccountId: 'IGACC', participantId: 'CUST', mid: 'm1', text: 'hello', echo: false, timestamp: 1 };
  const r = await ingestWebhookEntry('u1', item, { database, enqueueAi });
  assert.strictEqual(calls.insertMsg, 1);
  assert.strictEqual(calls.enqueue, 1);
  assert.strictEqual(r.stored, true);
});

test('ingestWebhookEntry skips echoes/empty without touching db', async () => {
  let touched = false;
  const database = { query: async () => { touched = true; return { rows: [] }; } };
  const r = await ingestWebhookEntry('u1', { echo: true, text: 'x', participantId: 'C' }, { database, enqueueAi: async () => {} });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(touched, false);
});

test('ingestWebhookEntry does NOT enqueue AI when conversation ai_paused', async () => {
  let enqueued = 0;
  const database = {
    query: async (sql) => {
      if (sql.includes('INSERT INTO instagram_conversations')) return { rows: [{ id: 'conv1', ai_paused: true }] };
      if (sql.includes('INSERT INTO instagram_messages')) return { rows: [{ id: 'msg1' }] };
      return { rows: [] };
    },
  };
  const r = await ingestWebhookEntry('u1', { participantId: 'C', mid: 'm', text: 'hi', echo: false }, { database, enqueueAi: async () => { enqueued++; } });
  assert.strictEqual(enqueued, 0);
  assert.strictEqual(r.aiPaused, true);
});

test('ensureUsername fetches + stores the @username when missing', async () => {
  const updates = [];
  const database = {
    query: async (sql, params) => {
      if (sql.includes('SELECT participant_username')) return { rows: [{ participant_username: null }] };
      if (sql.startsWith('UPDATE instagram_conversations')) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const accounts = { getAccountToken: async () => 'TOKEN' };
  const graph = { getUserProfile: async () => ({ username: 'sara_q8', name: 'Sara' }) };
  const u = await ensureUsername('u1', 'IGSID1', { database, accounts, graph });
  assert.strictEqual(u, 'sara_q8');
  assert.deepStrictEqual(updates[0], ['u1', 'IGSID1', 'sara_q8']);
});

test('ensureUsername skips the lookup when username already known', async () => {
  let graphCalled = 0;
  const database = { query: async (sql) => (sql.includes('SELECT participant_username') ? { rows: [{ participant_username: 'known' }] } : { rows: [] }) };
  const graph = { getUserProfile: async () => { graphCalled++; return {}; } };
  const u = await ensureUsername('u1', 'IGSID1', { database, accounts: { getAccountToken: async () => 'T' }, graph });
  assert.strictEqual(u, 'known');
  assert.strictEqual(graphCalled, 0);
});

test('ensureUsername is best-effort: returns null and never throws on failure', async () => {
  const database = { query: async () => ({ rows: [{ participant_username: null }] }) };
  const accounts = { getAccountToken: async () => 'T' };
  const graph = { getUserProfile: async () => { throw new Error('no profile access'); } };
  await assert.doesNotReject(async () => {
    const u = await ensureUsername('u1', 'IGSID1', { database, accounts, graph });
    assert.strictEqual(u, null);
  });
});

test('ingestWebhookEntry re-enqueues a duplicate mid that is still queued after a prior Redis failure', async () => {
  let enqueued = 0;
  const database = {
    query: async (sql) => {
      if (sql.includes('INSERT INTO instagram_conversations')) return { rows: [{ id: 'conv1', ai_paused: false }] };
      if (sql.includes('INSERT INTO instagram_messages')) return { rows: [] }; // ON CONFLICT DO NOTHING
      if (sql.includes('FROM instagram_messages') && sql.includes('provider_message_id')) {
        return { rows: [{ id: 'msg-existing', conversation_id: 'conv1', status: 'queued_for_ai' }] };
      }
      return { rows: [] };
    },
  };
  const r = await ingestWebhookEntry('u1', { participantId: 'C', mid: 'dup', text: 'hi', echo: false }, { database, enqueueAi: async () => { enqueued++; } });
  assert.strictEqual(enqueued, 1);
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(r.requeued, true);
});

test('ingestWebhookEntry marks a paused conversation message as ai_paused instead of leaving it stuck', async () => {
  const updates = [];
  const database = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO instagram_conversations')) return { rows: [{ id: 'conv1', ai_paused: true }] };
      if (sql.includes('INSERT INTO instagram_messages')) return { rows: [{ id: 'msg1' }] };
      if (sql.includes("SET status='ai_paused'")) updates.push(params);
      return { rows: [] };
    },
  };
  await ingestWebhookEntry('u1', { participantId: 'C', mid: 'm', text: 'hi', echo: false }, { database, enqueueAi: async () => {} });
  assert.deepStrictEqual(updates, [['msg1', 'u1']]);
});
