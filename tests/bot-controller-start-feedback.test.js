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

test('start returns helpful message when start is already pending', async () => {
  const controller = createBotController({
    getUserBot: () => ({
      startBot: async () => false,
      appState: { status: 'waiting_qr', error: null },
    }),
  });
  const res = createResponse();

  await controller.start({ session: { userId: 'user-1' } }, res);

  assert.equal(res.body.success, true);
  assert.equal(res.body.started, false);
  assert.match(res.body.message, /QR|انتظر/);
});
