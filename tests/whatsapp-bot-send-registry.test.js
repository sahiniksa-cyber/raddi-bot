'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reserveBotSendId } = require('../src/services/whatsapp/baileys-connection-manager');

test('database migrations create a tenant-scoped durable bot-send registry', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'),
    'utf8',
  );

  assert.match(source, /CREATE TABLE IF NOT EXISTS whatsapp_bot_send_ids/);
  assert.match(source, /PRIMARY KEY \(user_id, whatsapp_message_id\)/);
  assert.match(source, /user_id UUID NOT NULL REFERENCES users\(id\)/);
});

test('a conflicting durable bot-send reservation fails closed', async () => {
  const database = {
    isConfigured: () => true,
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  await assert.rejects(
    () => reserveBotSendId({
      database,
      userId: 'u1',
      messageId: 'WAMID-1',
      target: '966500000001@s.whatsapp.net',
    }),
    error => error.code === 'BOT_SEND_ID_SCOPE_MISMATCH',
  );
});

test('server gates app readiness and workers on required migrations', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  const migration = main.indexOf('await runRequiredStartupMigration(startupState)');
  const appReady = main.indexOf('startupState.app = createApp()');
  const outgoingWorker = main.indexOf('createOutgoingWhatsappWorker({ getUserBot })');

  assert.ok(migration >= 0, 'main must await required migrations');
  assert.ok(migration < appReady, 'migration must finish before the full app is exposed');
  assert.ok(migration < outgoingWorker, 'migration must finish before outgoing worker starts');
});
