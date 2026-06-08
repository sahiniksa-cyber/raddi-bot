'use strict';

// Guards the single-flight fix for the getUserBot race. Production logs showed
// the same WhatsApp number being created 3× at boot (concurrent getUserBot
// calls each built their own RuntimeBot → competing sockets → 440). The
// resolver must run `create` EXACTLY ONCE per user no matter how many concurrent
// callers there are, and hand every caller the same instance.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBotResolver } = require('../src/runtime/bot-resolver');

function deferredCreate() {
  const calls = [];
  let resolveFn;
  const create = (userId) => {
    calls.push(userId);
    return new Promise((resolve) => { resolveFn = resolve; });
  };
  return { create, calls, finish: (bot) => resolveFn(bot) };
}

test('concurrent calls for the same user create the bot only once', async () => {
  const { create, calls, finish } = deferredCreate();
  const resolve = createBotResolver({ create });

  // Three callers race before creation finishes (mirrors boot: dashboard +
  // monitor + outgoing worker all calling getUserBot for one number).
  const p1 = resolve('user-1');
  const p2 = resolve('user-1');
  const p3 = resolve('user-1');

  assert.equal(calls.length, 1, 'create must run exactly once for concurrent callers');

  const bot = { id: 'the-one-bot' };
  finish(bot);

  const [b1, b2, b3] = await Promise.all([p1, p2, p3]);
  assert.equal(b1, bot);
  assert.equal(b2, bot, 'all callers receive the same instance');
  assert.equal(b3, bot);
});

test('after resolution the bot is served from cache without re-creating', async () => {
  const { create, calls, finish } = deferredCreate();
  const cache = new Map();
  const resolve = createBotResolver({ create, cache });

  const p1 = resolve('user-2');
  finish({ id: 'bot-2' });
  await p1;

  const again = await resolve('user-2');
  assert.equal(again.id, 'bot-2');
  assert.equal(calls.length, 1, 'a cached bot must not be re-created');
  assert.equal(cache.get('user-2').id, 'bot-2', 'resolved bot is stored in the shared cache');
});

test('different users each create their own bot', async () => {
  const calls = [];
  const create = async (userId) => { calls.push(userId); return { id: userId }; };
  const resolve = createBotResolver({ create });

  const [a, b] = await Promise.all([resolve('user-A'), resolve('user-B')]);
  assert.equal(a.id, 'user-A');
  assert.equal(b.id, 'user-B', 'distinct users get their own instance');
  assert.deepEqual(calls.sort(), ['user-A', 'user-B']);
});

test('a failed load is not cached and can be retried', async () => {
  let attempt = 0;
  const create = async (userId) => {
    attempt++;
    if (attempt === 1) throw new Error('load failed');
    return { id: `${userId}-ok` };
  };
  const resolve = createBotResolver({ create });

  await assert.rejects(() => resolve('user-3'), /load failed/);
  // Second attempt must re-run create (the failed in-flight entry was dropped).
  const bot = await resolve('user-3');
  assert.equal(bot.id, 'user-3-ok');
  assert.equal(attempt, 2);
});

test('createBotResolver requires a create function', () => {
  assert.throws(() => createBotResolver({}), /create function is required/);
});
