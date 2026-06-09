'use strict';

// Sockets are replaced on every reconnect — _socketGeneration is bumped each
// time start() opens a new socket. If a dying socket's messages.upsert event
// arrives AFTER the new socket has been wired up, both sockets' pipelines
// would ingest the same message → two replies in the same second.
// This guard mirrors what handleConnectionUpdate already does for connection
// state events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('messages.upsert listener checks _socketGeneration before processing', () => {
  // Static check on the listener wiring. The listener captures socketGeneration
  // in its closure and compares to this._socketGeneration at event time.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'),
    'utf8',
  );
  // The on('messages.upsert', ...) block must include a generation check.
  const upsertBlock = src.match(/sock\.ev\.on\('messages\.upsert',[\s\S]*?\}\);/);
  assert.ok(upsertBlock, 'messages.upsert listener exists');
  assert.match(upsertBlock[0], /socketGeneration\s*!==\s*this\._socketGeneration/,
    'listener must drop events from stale socket generation');
});

test('manager.handleMessages still processes when running (positive control)', () => {
  const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: { query: async () => ({ rows: [] }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
  });
  manager._running = true;
  manager.handleMessages({ messages: [], type: 'notify' });
  assert.ok(true);
});

test('handleMessages bails out mid-batch if the socket generation rolls over', () => {
  // Per-message generation check: a reconnect during message processing
  // bumps _socketGeneration. The loop must stop on the next iteration so
  // ghosted messages from the dying socket aren't ingested into the new
  // pipeline → duplicate replies.
  const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: { query: async () => ({ rows: [] }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
  });
  manager._running = true;
  manager._socketGeneration = 5;
  manager._hasEverConnected = true; // disable startup-bulk guard
  let processedCount = 0;
  manager.processInboundBaileysMessage = async () => { processedCount++; };

  // Three messages — but we pass an OUTDATED generation. None should process.
  const fakeEvent = {
    type: 'notify',
    messages: [
      { key: { id: 'a', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'hi' }, messageTimestamp: Math.floor(Date.now() / 1000) },
      { key: { id: 'b', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'hi' }, messageTimestamp: Math.floor(Date.now() / 1000) },
      { key: { id: 'c', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'hi' }, messageTimestamp: Math.floor(Date.now() / 1000) },
    ],
  };
  manager.handleMessages(fakeEvent, /* socketGeneration */ 4); // stale
  assert.equal(processedCount, 0, 'stale generation must abort the whole batch before any message processes');
});

test('handleMessages processes when caller passes the current generation', () => {
  const { BaileysConnectionManager } = require('../src/services/whatsapp/baileys-connection-manager');
  const manager = new BaileysConnectionManager({
    userId: 'user-1',
    dataDir: __dirname,
    database: { query: async () => ({ rows: [] }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
  });
  manager._running = true;
  manager._socketGeneration = 5;
  manager._hasEverConnected = true;
  let processedCount = 0;
  manager.processInboundBaileysMessage = async () => { processedCount++; };

  const now = Math.floor(Date.now() / 1000);
  manager.handleMessages({
    type: 'notify',
    messages: [
      { key: { id: 'a', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'hi' }, messageTimestamp: now },
      { key: { id: 'b', remoteJid: 'y@s.whatsapp.net' }, message: { conversation: 'hi' }, messageTimestamp: now },
    ],
  }, 5);
  assert.equal(processedCount, 2);
});
