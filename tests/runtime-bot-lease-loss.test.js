'use strict';

// PR1 — lease-loss detection + clean shutdown teardown.
//
// _renewLeaseOnce: when the renewal UPDATE matches 0 rows, another instance has
// taken ownership of the WhatsApp session (e.g. a new Railway replica after a
// redeploy). We MUST stop our local socket so two sockets don't run against the
// same credentials and trigger a WhatsApp 440 (connectionReplaced). When the
// UPDATE matches a row, the bot keeps running untouched.
//
// releaseForShutdown: closes the live socket AND frees the lease (releasing only
// the DB lease left the old container connected until SIGKILL → 440 collision).

const test = require('node:test');
const assert = require('node:assert/strict');

const { RuntimeBot } = require('../src/services/bot/runtime-bot');

function makeFakeBot({ rowCount }) {
  const calls = { stop: 0, query: 0, clearedTimer: false };
  const fakeThis = {
    userId: 'user-1',
    instanceId: 'instance-A',
    _leaseRenewTimer: setInterval(() => {}, 60000),
    db: {
      query: async () => {
        calls.query++;
        return { rowCount };
      },
    },
    connection: {
      stop: async () => { calls.stop++; },
    },
    leaseExpiresAt: () => new Date(),
    logger: { warn: () => {}, info: () => {} },
  };
  // unref so the dummy interval never keeps the test process alive
  if (typeof fakeThis._leaseRenewTimer.unref === 'function') fakeThis._leaseRenewTimer.unref();
  return { fakeThis, calls };
}

test('_renewLeaseOnce stops the connection when the lease was lost (0 rows)', async () => {
  const { fakeThis, calls } = makeFakeBot({ rowCount: 0 });

  await RuntimeBot.prototype._renewLeaseOnce.call(fakeThis);

  assert.equal(calls.stop, 1, 'must stop the local socket when ownership is lost');
  assert.equal(fakeThis._leaseRenewTimer, null, 'must stop the renewal timer');
});

test('_renewLeaseOnce keeps the connection alive when the lease is still ours (1 row)', async () => {
  const { fakeThis, calls } = makeFakeBot({ rowCount: 1 });

  await RuntimeBot.prototype._renewLeaseOnce.call(fakeThis);

  assert.equal(calls.stop, 0, 'must NOT stop the socket while we still own the lease');
  assert.notEqual(fakeThis._leaseRenewTimer, null, 'renewal timer must keep running');
});

test('releaseForShutdown closes the socket then frees the lease', async () => {
  const order = [];
  const fakeThis = {
    connection: { stop: async () => { order.push('stop'); } },
    releaseConnectionLease: async () => { order.push('release'); },
  };

  await RuntimeBot.prototype.releaseForShutdown.call(fakeThis);

  assert.deepEqual(order, ['stop', 'release'], 'must close the socket before releasing the lease');
});

test('releaseForShutdown still frees the lease if closing the socket throws', async () => {
  const order = [];
  const fakeThis = {
    connection: { stop: async () => { order.push('stop'); throw new Error('socket boom'); } },
    releaseConnectionLease: async () => { order.push('release'); },
  };

  await RuntimeBot.prototype.releaseForShutdown.call(fakeThis);

  assert.deepEqual(order, ['stop', 'release'], 'lease must be released even when stop() throws');
});
