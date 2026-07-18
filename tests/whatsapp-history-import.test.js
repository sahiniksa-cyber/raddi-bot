'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');
const { createCampaignService, resolveAudience } = require('../src/services/campaigns/campaign-service');
const { BaileysPostgresAuthState } = require('../src/services/whatsapp/baileys-postgres-auth');
const {
  createBaileysClientWrapper,
  BaileysConnectionManager,
} = require('../src/services/whatsapp/baileys-connection-manager');
const {
  WhatsAppHistoryImportService,
  buildHistoryRows,
  isMessageHistoryType,
  rebuildCompactHistorySearchIndex,
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

test('Baileys isLatest does not falsely finish the import after the first history chunk', async () => {
  const updates = [];
  const client = {
    query: async (sql, params) => {
      if (sql.includes("status IN ('starting','running') FOR UPDATE")) {
        return { rows: [{ id: 'import-1' }] };
      }
      if (sql.includes('UPDATE whatsapp_history_imports SET')) updates.push(params);
      return { rows: [] };
    },
  };
  const service = new WhatsAppHistoryImportService({
    userId: 'user-1',
    database: { transaction: async fn => fn(client), query: client.query },
  });
  const result = await service.ingestHistorySet('import-1', {
    syncType: 3,
    progress: 5,
    isLatest: true,
    chats: [],
    contacts: [],
    messages: [],
  });
  assert.equal(result.explicitlyComplete, false);
  assert.equal(updates[0][3], false);
});

test('history import pairing uses isolated temporary auth instead of the live bot auth', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT import_auth_state AS auth_state')) {
        return { rows: [{ auth_state: {} }] };
      }
      return { rows: [] };
    },
  };
  const store = new BaileysPostgresAuthState({
    db: database,
    userId: 'user-history',
    historyImportId: 'import-fresh-pairing',
  });
  await store.load();
  await store.persist();
  assert.ok(calls.some(call => call.sql.includes('FROM whatsapp_history_imports')));
  assert.ok(calls.some(call => call.sql.includes('SET import_auth_state = $3::jsonb')));
  assert.equal(calls.some(call => call.sql.includes('UPDATE whatsapp_sessions')), false);
});

test('history import uses the QR-compatible Chrome browser identity', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/whatsapp/baileys-connection-manager.js'),
    'utf8',
  );
  assert.match(source, /browser:\s*Browsers\.ubuntu\('Chrome'\)/);
  assert.doesNotMatch(source, /browser:\s*historyImportMode\s*\?\s*Browsers\.macOS/);
});

test('history import idle countdown does not start before the temporary QR is scanned', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-wait-qr-'));
  const logger = { info() {}, warn() {}, error() {}, log() {}, all() { return []; } };
  const bot = new RuntimeBot('user-history-wait-qr', {
    dataDir: tmp,
    database: { query: async () => ({ rows: [] }) },
    logger,
  });
  bot.scheduleHistoryImportTimers('import-waiting-qr', {
    started_at: new Date().toISOString(),
    connected_at: null,
    last_event_at: null,
  });
  assert.equal(bot._historyImportIdleTimer, null);
  assert.ok(bot._historyImportMaxTimer);
  bot.scheduleHistoryImportTimers('import-waiting-qr', {
    started_at: new Date().toISOString(),
    connected_at: new Date().toISOString(),
    last_event_at: null,
  });
  assert.ok(bot._historyImportIdleTimer);
  bot.clearHistoryImportTimers();
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
  bot.createHistoryImportConnection = function createHistoryImportConnection(importId) {
    this._historyImportConnection = {
      _historyImport: { enabled: true, importId },
      state: () => ({ status: 'qr_ready', readOnly: true, historyImportMode: true }),
      start: async () => true,
    };
    return this._historyImportConnection;
  };
  await bot.loadSessionState();
  assert.equal(bot.connection.state().readOnly, false);
  assert.equal(bot._historyImportConnection.state().readOnly, true);
  assert.equal(bot._historyImportConnection._historyImport.importId, 'import-active');
  clearTimeout(bot._autoRecoverTimer);
  bot.clearHistoryImportTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a restored import beyond the maximum duration is finished automatically', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-timeout-'));
  const logger = { info() {}, warn() {}, error() {}, log() {}, all() { return []; } };
  const bot = new RuntimeBot('user-history-timeout', {
    dataDir: tmp,
    database: { query: async () => ({ rows: [] }) },
    logger,
  });
  bot._historyImportConnection = {
    _historyImport: { enabled: true, importId: 'import-expired' },
  };
  const finished = [];
  bot.finishHistoryImport = async (importId, options) => {
    finished.push({ importId, options });
    bot.clearHistoryImportTimers();
    bot._historyImportConnection = null;
    return { status: 'partial' };
  };
  bot.scheduleHistoryImportTimers('import-expired', {
    started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    last_event_at: new Date().toISOString(),
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(finished, [{
    importId: 'import-expired',
    options: { reason: 'maximum_duration' },
  }]);
  bot.clearHistoryImportTimers();
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

test('compact history index groups inbound text by customer and day before raw cleanup', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ documents: 3, messages: 12, bytes: 640 }] };
    },
  };

  const result = await rebuildCompactHistorySearchIndex(
    database,
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
  );

  assert.deepEqual(result, { documents: 3, messages: 12, bytes: 640 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO whatsapp_history_search_index/);
  assert.match(calls[0].sql, /STRING_AGG/);
  assert.match(calls[0].sql, /m\.direction = 'inbound'/);
  assert.match(calls[0].sql, /GROUP BY m\.user_id, m\.sender, COALESCE\(m\.message_at, m\.created_at\)::date/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id, sender, bucket_date\) DO UPDATE/);
  assert.doesNotMatch(calls[0].sql, /DELETE FROM whatsapp_history_search_index/);
});

test('keyword audience remains searchable from the compact index after raw rows are gone', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM whatsapp_history_search_index s')) {
        return { rows: [{
          conversation_id: null,
          sender: '12345@lid',
          normalized_phone: '966500000001',
          customer_name: 'عميل العدسات',
          product_name: 'شنط',
          evidence_text: '',
          source: 'keyword_history',
        }] };
      }
      return { rows: [] };
    },
  };

  const recipients = await resolveAudience(database, 'user-1', {
    source: 'keywords',
    searchTerms: ['شنط'],
    dateFrom: '2026-07-01',
    dateTo: '2026-07-18',
  });

  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].normalized_phone, '966500000001');
  const compactCall = calls.find(call => call.sql.includes('FROM whatsapp_history_search_index s'));
  assert.ok(compactCall);
  assert.match(compactCall.sql, /STRPOS\(LOWER\(s\.search_document\), LOWER\(keyword\.term\)\)/);
  assert.match(compactCall.sql, /s\.bucket_date >= \$3::date/);
  assert.match(compactCall.sql, /s\.bucket_date <= \$4::date/);
  assert.deepEqual(compactCall.params, ['user-1', ['شنط'], '2026-07-01', '2026-07-18']);
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
    sessionDesiredState: 'running',
    connection: { ready: true, status: 'connected' },
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
  assert.deepEqual(order.slice(-3), ['created-import', 'started:import-1', 'unlocked-send']);
  const insert = order.indexOf('created-import');
  assert.ok(insert > -1);
});

test('history import status exposes the real QR and database counters together', async () => {
  const database = {
    query: async sql => {
      if (sql.includes('FROM whatsapp_history_imports i')) {
        return { rows: [{
          id: 'import-qr',
          status: 'running',
          started_at: new Date().toISOString(),
          connected_at: null,
          last_event_at: null,
          conversations_total: 0,
          numbers_total: 0,
          messages_total: 0,
          inbound_messages_total: 0,
          resume_after_import: true,
        }] };
      }
      return { rows: [] };
    },
  };
  const service = createCampaignService({
    database,
    getUserBot: async () => ({
      historyImportAppState: {
        status: 'qr_ready',
        qrString: 'temporary-qr',
        qrVersion: 7,
      },
      appState: {
        status: 'connected',
        qrString: null,
        qrVersion: 2,
      },
    }),
  });
  const status = await service.historyImportStatus('user-1');
  assert.equal(status.qr_ready, true);
  assert.equal(status.qr_version, 7);
  assert.equal(status.connection_error, null);
  assert.equal(status.conversations_total, 0);
  assert.equal(status.live_session_will_resume, true);
});

test('history import uses a separate socket and never stops or replaces the live bot connection', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-separate-'));
  const logger = { info() {}, warn() {}, error() {}, log() {}, all() { return []; } };
  const bot = new RuntimeBot('user-history-separate', {
    dataDir: tmp,
    database: { query: async () => ({ rows: [] }) },
    logger,
  });
  const liveCalls = [];
  bot.connection.status = 'connected';
  bot.connection.ready = true;
  bot.connection.stop = async () => { liveCalls.push('stop'); };
  bot.acquireConnectionLease = async () => { liveCalls.push('lease'); return true; };
  bot.persistSessionState = async () => { liveCalls.push('persist'); };
  bot.historyImport.markRunning = async () => ({
    id: 'import-separate',
    started_at: new Date().toISOString(),
    connected_at: null,
    last_event_at: null,
  });
  bot.historyImport.latestStatus = async () => ({ id: 'import-separate', status: 'running' });
  const temporaryCalls = [];
  bot.createHistoryImportConnection = function createHistoryImportConnection(importId) {
    this._historyImportConnection = {
      _historyImport: { enabled: true, importId },
      start: async () => { temporaryCalls.push('start'); return true; },
    };
    return this._historyImportConnection;
  };

  const result = await bot.startHistoryImport('import-separate');
  assert.equal(result.status, 'running');
  assert.deepEqual(temporaryCalls, ['start']);
  assert.deepEqual(liveCalls, []);
  assert.equal(bot.connection.status, 'connected');
  assert.equal(bot.connection.ready, true);
  bot.clearHistoryImportTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('finishing the temporary history socket leaves the live bot connected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jwab-history-finish-separate-'));
  const logger = { info() {}, warn() {}, error() {}, log() {}, all() { return []; } };
  const bot = new RuntimeBot('user-history-finish-separate', {
    dataDir: tmp,
    database: { query: async () => ({ rows: [] }) },
    logger,
  });
  const liveCalls = [];
  bot.connection.status = 'connected';
  bot.connection.ready = true;
  bot.connection.stop = async () => { liveCalls.push('stop'); };
  const temporaryCalls = [];
  bot._historyImportConnection = {
    _historyImport: { enabled: true, importId: 'import-finish-separate' },
    closeHistoryImportDevice: async () => { temporaryCalls.push('close'); },
    stop: async () => { temporaryCalls.push('stop'); },
  };
  bot.historyImport.finishImport = async () => ({
    id: 'import-finish-separate',
    status: 'completed',
  });

  const result = await bot.finishHistoryImport('import-finish-separate');
  assert.equal(result.status, 'completed');
  assert.deepEqual(temporaryCalls, ['close']);
  assert.deepEqual(liveCalls, []);
  assert.equal(bot.connection.status, 'connected');
  assert.equal(bot.connection.ready, true);
  assert.equal(bot._historyImportConnection, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a zero-row import is marked failed instead of pretending partial success', async () => {
  const calls = [];
  const service = new WhatsAppHistoryImportService({
    userId: 'user-1',
    database: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('WITH imported AS')) {
          return { rows: [{ id: 'import-empty', status: 'failed', last_error: 'لم يرسل واتساب أي محادثات' }] };
        }
        return { rows: [] };
      },
    },
  });
  const result = await service.finishImport('import-empty', { reason: 'idle_timeout' });
  assert.equal(result.status, 'failed');
  assert.match(calls[0].sql, /imported\.conversations = 0 AND imported\.messages = 0 THEN 'failed'/);
  assert.match(calls[0].sql, /import_auth_state = '\{\}'::jsonb/);
});

test('a successful import builds the compact index before deleting raw history', async () => {
  const order = [];
  const service = new WhatsAppHistoryImportService({
    userId: '22222222-2222-4222-8222-222222222222',
    database: {
      query: async sql => {
        if (sql.includes('WITH imported AS')) {
          order.push('finish');
          return { rows: [{ id: 'import-1', status: 'completed' }] };
        }
        if (sql.includes('INSERT INTO whatsapp_history_search_index')) {
          order.push('index');
          return { rows: [{ documents: 4, messages: 15, bytes: 900 }] };
        }
        if (sql.includes('DELETE FROM whatsapp_history_messages')) {
          order.push('delete-messages');
          return { rows: [{ count: 15 }] };
        }
        if (sql.includes('DELETE FROM whatsapp_history_conversations')) {
          order.push('delete-conversations');
          return { rows: [{ count: 4 }] };
        }
        if (sql.includes('UPDATE whatsapp_history_imports SET')) {
          order.push('record-cleanup');
        }
        return { rows: [] };
      },
    },
  });

  const result = await service.finishImport(
    '11111111-1111-4111-8111-111111111111',
    { reason: 'idle_timeout' },
  );

  assert.deepEqual(result.search_index, { documents: 4, messages: 15, bytes: 900 });
  assert.deepEqual(result.purged, { messages: 15, conversations: 4 });
  assert.deepEqual(order, [
    'finish',
    'index',
    'delete-messages',
    'delete-conversations',
    'record-cleanup',
  ]);
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

test('an approved imported recipient no longer depends on raw history rows', async () => {
  let queried = false;
  const database = { query: async () => { queried = true; return { rows: [] }; } };
  const matches = await recipientMatchesKeywordAudience(
    database,
    { user_id: 'user-1' },
    { source: 'saved_history_number', sender: '12345@lid', conversation_id: null },
    { source: 'keywords', searchTerms: ['عدسات'] },
  );
  assert.equal(matches, true);
  assert.equal(queried, false);
});

test('history tables stay isolated from the live messages table and UI states no sending', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/db/migrations/init.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '../dashboard/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../dashboard/campaigns.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS whatsapp_history_messages/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_history_imports_one_active/);
  assert.match(migration, /purged_messages_count/);
  assert.match(migration, /import_auth_state/);
  assert.match(migration, /resume_after_import/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS whatsapp_history_search_index/);
  assert.match(migration, /PRIMARY KEY \(user_id, sender, bucket_date\)/);
  assert.doesNotMatch(migration, /INSERT INTO messages/);
  assert.match(dashboard, /يبقى البوت الأساسي متصلاً ولا يطلق الاستيراد أي رسالة أو حملة/);
  assert.match(dashboard, /campaignHistoryQrImage/);
  assert.match(routes, /bot\?\.historyImportAppState/);
  assert.match(script, /المحفوظ فعلياً الآن/);
  assert.match(script, /لن تُرسل أي رسالة/);
});
