'use strict';

// Boot-time WhatsApp recovery.
//
// Problem: a RuntimeBot is only created when getUserBot(userId) is called — i.e.
// when someone opens that user's dashboard. After a redeploy/restart, a bot whose
// desired_state is 'running' therefore stays DOWN until a human happens to open
// its dashboard. On a multi-tenant platform that means every merchant's bot is
// offline after each deploy until visited — unacceptable if the platform is sold.
//
// Fix: on startup, look up every session with desired_state='running' and resolve
// its bot (which triggers the per-bot auto-recover). Resolutions are STAGGERED so
// 20+ bots don't all open WhatsApp sockets in the same tick (event-loop stall +
// lease contention + reconnect thundering-herd).
async function recoverRunningBots({
  db,
  resolveBot,
  staggerMs = parseInt(process.env.WA_BOOT_RECOVERY_STAGGER_MS || '1500', 10),
  schedule = setTimeout,
  log = () => {},
} = {}) {
  if (typeof resolveBot !== 'function') throw new Error('resolveBot is required');
  if (!db || typeof db.isConfigured !== 'function' || !db.isConfigured()) {
    return { scheduled: 0 };
  }

  let rows = [];
  try {
    const result = await db.query(
      "SELECT user_id FROM whatsapp_sessions WHERE desired_state = 'running'",
    );
    rows = result.rows || [];
  } catch (err) {
    log(`boot recovery query failed: ${err.message}`);
    return { scheduled: 0 };
  }

  rows.forEach((row, index) => {
    const userId = row.user_id;
    if (!userId) return;
    const timer = schedule(() => {
      Promise.resolve()
        .then(() => resolveBot(userId))
        .catch((err) => log(`boot recovery failed for ${userId}: ${err.message}`));
    }, index * Math.max(0, staggerMs));
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  if (rows.length) log(`scheduled boot recovery for ${rows.length} running WhatsApp bot(s)`);
  return { scheduled: rows.length };
}

module.exports = { recoverRunningBots };
