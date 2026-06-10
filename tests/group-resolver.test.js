'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveGroupJidByName, __cache } = require('../src/services/whatsapp/group-resolver');

function fakeBot(groups, { userId = 'u1' } = {}) {
  let fetchCount = 0;
  return {
    userId,
    get fetchCount() { return fetchCount; },
    sock: {
      groupFetchAllParticipating: async () => {
        fetchCount++;
        return groups;
      },
    },
  };
}

const GROUPS = {
  'a@g.us': { id: 'a@g.us', subject: 'متجر برو خدمة عملاء' },
  'b@g.us': { id: 'b@g.us', subject: 'فريق الشحن' },
};

test('resolves an exact (normalized) Arabic group name to its JID', async () => {
  __cache.clear();
  const bot = fakeBot(GROUPS);
  assert.equal(await resolveGroupJidByName(bot, 'متجر برو خدمة عملاء'), 'a@g.us');
  // Normalization: ه/ة and ا/أ variants must still match.
  assert.equal(await resolveGroupJidByName(bot, 'متجر برو خدمه عملاء'), 'a@g.us');
});

test('resolves a unique partial match, refuses ambiguous ones', async () => {
  __cache.clear();
  const bot = fakeBot(GROUPS);
  assert.equal(await resolveGroupJidByName(bot, 'فريق الشحن السريع'), 'b@g.us');

  __cache.clear();
  const ambiguous = fakeBot({
    'a@g.us': { id: 'a@g.us', subject: 'خدمة عملاء فرع الرياض' },
    'b@g.us': { id: 'b@g.us', subject: 'خدمة عملاء فرع جدة' },
  });
  assert.equal(await resolveGroupJidByName(ambiguous, 'خدمة عملاء'), null);
});

test('returns null when no match, empty name, or no socket', async () => {
  __cache.clear();
  assert.equal(await resolveGroupJidByName(fakeBot(GROUPS), 'قروب غير موجود'), null);
  assert.equal(await resolveGroupJidByName(fakeBot(GROUPS), ''), null);
  // Different user (cold cache) with no socket — must fail-null, not throw.
  assert.equal(await resolveGroupJidByName({ userId: 'no-sock-user' }, 'متجر برو خدمة عملاء'), null);
});

test('caches the group list per user instead of refetching every send', async () => {
  __cache.clear();
  const bot = fakeBot(GROUPS);
  await resolveGroupJidByName(bot, 'متجر برو خدمة عملاء');
  await resolveGroupJidByName(bot, 'فريق الشحن');
  assert.equal(bot.fetchCount, 1, 'second resolution must hit the cache');
});
