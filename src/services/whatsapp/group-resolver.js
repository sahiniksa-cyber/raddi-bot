'use strict';

const { normalizeArabic } = require('../../workers/escalation-routing');

const CACHE_TTL_MS = parseInt(process.env.GROUP_RESOLVE_CACHE_TTL_MS || '600000', 10);
const cache = new Map(); // userId -> { at, groups: [{ jid, subject }] }

async function fetchGroups(bot) {
  const cached = cache.get(bot?.userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.groups;
  const sock = bot?.sock;
  if (!sock?.groupFetchAllParticipating) return null;
  const raw = await sock.groupFetchAllParticipating();
  const groups = Object.values(raw || {}).map((g) => ({ jid: g.id, subject: String(g.subject || '') }));
  cache.set(bot.userId, { at: Date.now(), groups });
  return groups;
}

// Resolves a human-entered group NAME to its @g.us JID using the account's
// joined groups. Exact normalized-Arabic match wins; otherwise a UNIQUE
// partial match. Returns null when not found or ambiguous — the caller must
// fail loudly rather than guess and message the wrong group.
async function resolveGroupJidByName(bot, name) {
  const wanted = normalizeArabic(name);
  if (!wanted) return null;
  const groups = await fetchGroups(bot);
  if (!groups) return null;

  const exact = groups.filter((g) => normalizeArabic(g.subject) === wanted);
  if (exact.length === 1) return exact[0].jid;

  const partial = groups.filter((g) => {
    const subject = normalizeArabic(g.subject);
    return subject && (subject.includes(wanted) || wanted.includes(subject));
  });
  return partial.length === 1 ? partial[0].jid : null;
}

module.exports = { resolveGroupJidByName, __cache: cache };
