'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');
const { createCampaignService, resolveAudience } = require('../src/services/campaigns/campaign-service');
const {
  createBaileysClientWrapper,
  BaileysConnectionManager,
} = require('../src/services/whatsapp/baileys-connection-manager');
const {
  buildHistoryRows,
  isMessageHistoryType,
} = require('../src/services/whatsapp/history-import.service');
const { recipientMatchesKeywordAudience } = require('../src/workers/campaign-worker');

test('history import extracts direct customer numbers and messages without live ingestion', () => {
  const event = {
    lidPnMappings: [{ lid: '12345@lid', pn: '966500000001@s.whatsapp.net' }],
    contacts: [{ id: '12345@lid', name: 'عميل العدسات' }],
    chats: [{ id: '12345@lid', conversationTimestamp: 1_720_000_000 }],
    messages: [
      {
        key: { id: 'in-1', remoteJid: '12345@lid', fromMe: false },
        messageTimestamp: 1_720_000_001,
        message: { conversation: 'السلام عليكم، كم سعر العدسات؟' },
      },
      {
        key: { id: 'out-1', remoteJid: '12345@lid', fromMe: true },
        messageTimestamp: 1_720_000_002,
        message: { conversation: 'وعليكم السلام' },
      },
      {
        key: { id: 'group-1', remoteJid: '555@g.us', fromMe: false },
        messageTimestamp: 1_720_000_003,
        message: { conversation: 'رسالة مجموعة' },
      },
    ],
  };

  const result = buildHistoryRows(event);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].sender, '12345@lid');
  assert.equal(result.conversations[0].normalized_phone, '966500000001');
  assert.equal(result.conversations[0].customer_name, 'عميل العدسات');
  assert.deepEqual(result.messages.map(row => row.direction), ['inbound', 'outbound']);
  assert.match(result.messages[0].content, /العدسات/);
});

test('only customer-message history phases can mark a full import complete', () => {
  assert.equal(isMessageHistoryType(0), false); // INITIAL_BOOTSTRAP
  assert.equal(isMessageHistoryType(4), false); // PUSH_NAME
  assert.equal(isMessageHistoryType(2), true); // FULL
  assert.equal(isMessageHistoryType(3), true); // RECENT
  assert.equal(isMessageHistoryType(6), true); // ON_DEMAND
});

test('Baileys sendMessage is hard-blocked in read-only history mode', async () => {
  let sent = 0;
  const client = createBaileysClientWrapper({
    sock: {
      sendMessage: async () => { sent += 1; },
      sendPresenceUpdate: async () => {},
    },
    isReady: () => true,
    isReadOnly: () => true,
    status: () => 'connected',
  });

  await assert.rejects(
    () => client.sendMessage('966500000001', 'اختبار'),
    error => error.code === 'HISTORY_IMPORT_READ_ONLY',
  );
  assert.equal(sent, 0);
});

test('connection manager exposes read-only state while history import is active', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-manager-'));
  const manager = new BaileysConnectionManager({
    userId: 'user-history',
    dataDir: tmp,
    historyImportService: { enqueueHistorySet: async () => {}, enqueueLiveUpsert: async () => {} },
  });
  manager.setHistoryImportMode({ enabled: true, importId: 'import-1' });
  assert.equal(manager.state().historyImportMode, true);
  assert.equal(manager.state().readOnly, true);
  manager.setHistoryImportMode({ enabled: false });
  manager.setHistoryImportSendLock(true);
  assert.equal(manager.state().historyImportMode, false);
  assert.equal(manager.state().readOnly, true);
  manager.setHistoryImportSendLock(false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an active import is restored as read-only before automatic WhatsApp recovery', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-runtime-'));
  const database = {
    query: async sql => {
      if (sql.includes('INSERT INTO whatsapp_sessions')) {
        return { rows: [{ desired_state: 'running', status: 'stopped', updated_at: new Date().toISOString() }] };
      }
      if (sql.includes('FROM whatsapp_history_imports')) return { rows: [{ id: 'import-active' }] };
      return { rows: [] };
    },
  };
  const logger = { info() {}, warn() {}, error() {}, log() {}, all() { return []; } };
  const bot = new RuntimeBot('user-history', { dataDir: tmp, database, logger });
  bot.persistSessionState = async () => {};
  await bot.loadSessionState();
  assert.equal(bot.connection.state().readOnly, true);
  assert.equal(bot.connection._historyImport.importId, 'import-active');
  clearTimeout(bot._autoRecoverTimer);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('keyword audience includes numbers found only in imported WhatsApp history', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM whatsapp_history_conversations c')) {
        return { rows: [{
          conversation_id: null,
          sender: '12345@lid',
          normalized_phone: '966500000001',
          customer_name: 'عميل العدسات',
          product_name: 'عدسات',
          evidence_text: 'كم سعر العدسات؟',
          source: 'keyword_history',
        }] };
      }
      return { rows: [] };
    },
  };

  const recipients = await resolveAudience(database, 'user-1', {
    source: 'keywords',
    searchTerms: ['عدسات'],
  });
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].normalized_phone, '966500000001');
  assert.equal(recipients[0].source, 'keyword_history');
  assert.ok(calls.some(call => call.sql.includes("m.direction = 'inbound'")));
});

test('starting an import locks outgoing sends before the import row is created', async () => {
  const order = [];
  const database = {
    query: async sql => {
      if (sql.includes("status IN ('sending','scheduled')")) return { rows: [{ count: 0 }] };
      if (sql.includes("status IN ('starting','running')") && sql.includes('SELECT id')) {
        order.push('checked-import');
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO whatsapp_history_imports')) {
        order.push('created-import');
        return { rows: [{ id: 'import-1', status: 'starting' }] };
      }
      return { rows: [] };
    },
  };
  const bot = {
    lockHistoryImportSending() { order.push('locked-send'); },
    unlockHistoryImportSending() { order.push('unlocked-send'); },
    async startHistoryImport(id) {
      order.push(`started:${id}`);
      return { id, status: 'running', read_only: true };
    },
  };
  const service = createCampaignService({ database, getUserBot: async () => bot });
  const result = await service.startHistoryImport('user-1');
  assert.equal(result.read_only, true);
  assert.ok(order.indexOf('locked-send') < order.indexOf('created-import'));
  assert.deepEqual(order.slice(-2), ['created-import', 'started:import-1']);
});

test('campaign worker rechecks imported keyword evidence before a later send', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ exists: 1 }] };
    },
  };
  const matches = await recipientMatchesKeywordAudience(
    database,
    { user_id: 'user-1' },
    { source: 'keyword_history', sender: '12345@lid', conversation_id: null },
    { source: 'keywords', searchTerms: ['عدسات'] },
  );
  assert.equal(matches, true);
  assert.match(calls[0].sql, /whatsapp_history_messages/);
  assert.deepEqual(calls[0].params, ['user-1', '12345@lid', ['عدسات']]);
});

test('history tables stay isolated from the live messages table and UI states no sending', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/init.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '../dashboard/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../dashboard/campaigns.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS whatsapp_history_messages/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_history_imports_one_active/);
  assert.doesNotMatch(migration, /INSERT INTO messages/);
  assert.match(dashboard, /لا يشغّل الرد الآلي ولا يرسل أي رسالة أو حملة أثناء الاستيراد/);
  assert.match(script, /HISTORY_IMPORT_READ_ONLY|لن تُرسل أي رسالة/);
});
