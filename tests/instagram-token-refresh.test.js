'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { refreshDueTokens } = require('../src/services/instagram/token-refresh');

test('refreshes each connected account and stores the new token', async () => {
  const saved = [];
  const deps = {
    accounts: {
      listConnectedAccounts: async () => [{ user_id: 'u1' }],
      getAccountToken: async () => 'OLD',
      getAccount: async () => ({ ig_user_id: '17', ig_username: 'x' }),
      upsertAccount: async (uid, o) => saved.push({ uid, o }),
    },
    oauth: { refreshLongLived: async () => ({ accessToken: 'NEW', expiresAt: new Date(0) }) },
    logInstagram: async () => {},
  };
  await refreshDueTokens(deps);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].o.token, 'NEW');
});

test('one account failing does not stop the others', async () => {
  let saved = 0;
  const logs = [];
  const deps = {
    accounts: {
      listConnectedAccounts: async () => [{ user_id: 'bad' }, { user_id: 'good' }],
      getAccountToken: async (uid) => {
        if (uid === 'bad') throw new Error('token decode failed');
        return 'OLD';
      },
      getAccount: async () => ({ ig_user_id: '17' }),
      upsertAccount: async () => { saved++; },
    },
    oauth: { refreshLongLived: async () => ({ accessToken: 'NEW', expiresAt: new Date(0) }) },
    logInstagram: async (uid, level, evt) => { logs.push({ uid, level, evt }); },
  };
  await refreshDueTokens(deps);
  assert.strictEqual(saved, 1, 'good account still refreshed');
  assert.strictEqual(logs.length, 1, 'bad account logged an error');
  assert.strictEqual(logs[0].uid, 'bad');
});

test('skips accounts with no decodable token', async () => {
  let refreshed = 0;
  const deps = {
    accounts: {
      listConnectedAccounts: async () => [{ user_id: 'u1' }],
      getAccountToken: async () => null,
      getAccount: async () => ({}),
      upsertAccount: async () => {},
    },
    oauth: { refreshLongLived: async () => { refreshed++; return { accessToken: 'x', expiresAt: new Date(0) }; } },
    logInstagram: async () => {},
  };
  await refreshDueTokens(deps);
  assert.strictEqual(refreshed, 0);
});
