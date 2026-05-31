'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBotController,
  describeStartState,
} = require('../src/controllers/bot.controller');

function createResponse() {
  return {
    code: 200,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('describeStartState guides user when QR is ready', () => {
  assert.match(describeStartState({ status: 'qr_ready' }), /امسح/);
});

test('describeStartState guides user when connection is still starting', () => {
  assert.match(describeStartState({ status: 'connecting' }), /انتظر/);
});

test('start responds immediately and guides the user (non-blocking)', async () => {
  let startCalled = false;
  const controller = createBotController({
    getUserBot: () => ({
      startBot: async () => { startCalled = true; return false; },
      appState: { status: 'waiting_qr', error: null },
    }),
  });
  const res = createResponse();

  await controller.start({ session: { userId: 'user-1' } }, res);

  assert.equal(res.body.success, true);
  assert.match(res.body.message, /QR|انتظر|الباركود/);
  // startBot is kicked off (fire-and-forget) on the next microtask.
  await Promise.resolve();
  assert.equal(startCalled, true);
});

test('start does NOT hang the response even if startBot never resolves', async () => {
  // Simulates the ~20s connection.start() handshake. The HTTP response must
  // not wait for it — otherwise the connect button hangs the page.
  const controller = createBotController({
    getUserBot: () => ({
      startBot: () => new Promise(() => {}), // never resolves
      appState: { status: 'stopped', error: null },
    }),
  });
  const res = createResponse();

  await Promise.race([
    controller.start({ session: { userId: 'user-1' } }, res),
    new Promise((_, reject) => setTimeout(() => reject(new Error('start() blocked on startBot')), 1000)),
  ]);

  assert.equal(res.body.success, true);
  assert.equal(res.body.started, true);
});
