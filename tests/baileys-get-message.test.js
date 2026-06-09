'use strict';

// getStoredMessage is Baileys' retry-receipt callback. When a peer can't decrypt
// one of our sent replies, WhatsApp asks the server to ask us to resend. Without
// this callback returning the original text, the peer rebuilds its Signal
// session via a new prekey bundle and every in-flight message on the OLD
// session decrypts to "Bad MAC" at our end.

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');

function createManager({ db } = {}) {
  return new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: db || { query: async () => ({ rows: [] }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
  });
}

test('getStoredMessage returns conversation text for a known whatsapp_message_id', async () => {
  let capturedQuery = null;
  let capturedValues = null;
  const db = {
    query: async (sql, values) => {
      capturedQuery = sql;
      capturedValues = values;
      return { rows: [{ content: 'مرحبا، كيف أقدر أساعدك؟' }] };
    },
  };
  const manager = createManager({ db });
  const result = await manager.getStoredMessage({ id: 'WA-MSG-42', remoteJid: '966500000000@s.whatsapp.net' });
  assert.deepEqual(result, { conversation: 'مرحبا، كيف أقدر أساعدك؟' });
  assert.match(capturedQuery, /SELECT content FROM messages/);
  assert.match(capturedQuery, /whatsapp_message_id\s*=\s*\$2/);
  assert.deepEqual(capturedValues, ['user-1', 'WA-MSG-42']);
});

test('getStoredMessage returns undefined when the message is not found', async () => {
  const manager = createManager({ db: { query: async () => ({ rows: [] }) } });
  const result = await manager.getStoredMessage({ id: 'unknown-id' });
  assert.equal(result, undefined);
});

test('getStoredMessage returns undefined when key.id is missing', async () => {
  let called = false;
  const manager = createManager({ db: { query: async () => { called = true; return { rows: [] }; } } });
  assert.equal(await manager.getStoredMessage({}), undefined);
  assert.equal(await manager.getStoredMessage(null), undefined);
  assert.equal(await manager.getStoredMessage({ id: '' }), undefined);
  assert.equal(called, false, 'DB must not be queried when key.id is empty');
});

test('getStoredMessage swallows DB errors (peer falls back to placeholder)', async () => {
  const manager = createManager({
    db: { query: async () => { throw new Error('connection refused'); } },
  });
  // Returning undefined is the safe failure mode. Throwing would crash Baileys'
  // retry-receipt handler and leave the peer worse off than the placeholder path.
  const result = await manager.getStoredMessage({ id: 'WA-MSG-X' });
  assert.equal(result, undefined);
});
