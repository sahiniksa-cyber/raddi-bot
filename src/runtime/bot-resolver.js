'use strict';

// Single-flight bot resolver.
//
// The old getUserBot used a check-then-act pattern:
//   if (!botCache.has(userId)) { bot = new RuntimeBot(...); await bot.load(); botCache.set(...) }
// At boot, several callers (dashboard requests + health monitor + outgoing
// worker) hit getUserBot for the SAME user concurrently. Because `await
// bot.load()` yields before the cache is set, every concurrent caller saw an
// empty cache and constructed its OWN RuntimeBot — producing multiple WhatsApp
// sockets for one number that fight each other and trigger 440
// (connectionReplaced). Production logs showed the same userId "auto recovering"
// three times in the same millisecond.
//
// createBotResolver dedups in-flight creations: concurrent callers for the same
// userId share ONE promise, so `create` runs exactly once per user. Resolved
// bots live in `cache` (a plain Map) so existing consumers that read it
// directly — e.g. the shutdown lease-release loop and the synchronous bot
// lookup — keep working unchanged.
function createBotResolver({ create, cache = new Map(), loading = new Map() } = {}) {
  if (typeof create !== 'function') throw new Error('create function is required');

  return function resolveBot(userId) {
    const existing = cache.get(userId);
    if (existing) return Promise.resolve(existing);

    let pending = loading.get(userId);
    if (!pending) {
      // Invoke create() synchronously so a single creation is registered before
      // any other concurrent caller is scheduled. Guard against a synchronous
      // throw so it surfaces as a rejected promise, not an exception here.
      let result;
      try {
        result = create(userId);
      } catch (err) {
        return Promise.reject(err);
      }
      pending = Promise.resolve(result).then((bot) => {
        cache.set(userId, bot);
        return bot;
      });
      loading.set(userId, pending);
      // Drop the in-flight entry on settle (success OR failure) so a later call
      // can retry after a failed load instead of being stuck on a dead promise.
      pending.catch(() => {}).finally(() => loading.delete(userId));
    }
    return pending;
  };
}

module.exports = { createBotResolver };
