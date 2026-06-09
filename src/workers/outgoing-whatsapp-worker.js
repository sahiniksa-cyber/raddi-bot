'use strict';

const { Worker } = require('bullmq');

const db = require('../db/client');
const { createRedisConnection } = require('../queues/redis');
const { QUEUE_NAMES, getQueues } = require('../queues/message-queue');
const { normalizeOutgoingJobKey } = require('../queues/outgoing-job-key');
const { decrementMessageQuota } = require('../services/billing/message-quota');
const { TIMERS } = require('../../lib/constants');

const WORKER_NAME = 'outgoing-whatsapp-worker';

async function updateJobStatus(jobKey, fields) {
  if (!db.isConfigured() || !jobKey) return;
  const assignments = [];
  const values = [QUEUE_NAMES.outgoingWhatsapp, jobKey];
  let i = values.length;
  for (const [key, value] of Object.entries(fields)) {
    i++;
    assignments.push(`${key} = $${i}`);
    values.push(value);
  }
  if (!assignments.length) return;
  await db.query(
    `UPDATE jobs
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE queue_name = $1 AND job_key = $2`,
    values,
  );
}

async function markReplyMessage(replyMessageId, status, rawPayload = {}) {
  if (!replyMessageId) return;
  await db.query(
    `UPDATE messages
     SET status = $2,
         raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb
     WHERE id = $1`,
    [replyMessageId, status, JSON.stringify(rawPayload)],
  );
}

// Records the Baileys-assigned WhatsApp message ID so getMessage(key) can look
// up the original text when the peer asks for a retry receipt. The lookup is
// what stops the Bad MAC cascade — without it Baileys returns undefined, the
// peer rebuilds its Signal session, and every in-flight message decrypts wrong.
// The user_id filter is load-bearing: getMessage looks up by (user_id, key.id),
// and we MUST guarantee the row we write under one user's key.id can never be
// updated by a different user's worker even if they share a Postgres pool.
async function recordWhatsappMessageId(userId, replyMessageId, whatsappMessageId) {
  if (!userId || !replyMessageId || !whatsappMessageId) return;
  await db.query(
    `UPDATE messages SET whatsapp_message_id = $3 WHERE user_id = $1 AND id = $2`,
    [userId, replyMessageId, String(whatsappMessageId)],
  ).catch((err) => {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] failed to record whatsapp_message_id: ${err.message}`);
  });
}

async function getPersistedJobCreatedAt(jobKey) {
  if (!db.isConfigured() || !jobKey) return null;
  const result = await db.query(
    `SELECT created_at
     FROM jobs
     WHERE queue_name = $1 AND job_key = $2
     LIMIT 1`,
    [QUEUE_NAMES.outgoingWhatsapp, jobKey],
  );
  return result.rows[0]?.created_at ? new Date(result.rows[0].created_at).getTime() : null;
}

const ESCALATION_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

function shouldSkipStaleOutgoingPayload(payload = {}, ageMs, maxAgeMs) {
  if (payload.escalation) {
    // Now that ai-worker has dedup via escalation_log, we can safely cap escalation
    // age. Previously this was unlimited, which caused multi-hour spam on restart.
    return ageMs > ESCALATION_MAX_AGE_MS;
  }
  return maxAgeMs > 0 && ageMs > maxAgeMs;
}

async function skipStaleOutgoingJob(job, { replyMessageId }) {
  const maxAgeMs = parseInt(process.env.OUTGOING_STALE_JOB_MAX_AGE_MS || '600000', 10);
  if (maxAgeMs <= 0) return false;

  const createdAt = await getPersistedJobCreatedAt(job.id) || job.timestamp || Date.now();
  const ageMs = Date.now() - createdAt;
  if (!shouldSkipStaleOutgoingPayload(job.data || {}, ageMs, maxAgeMs)) return false;

  const message = `expired stale outgoing reply age=${Math.round(ageMs / 1000)}s`;
  await markReplyMessage(replyMessageId, 'expired', {
    sentBy: WORKER_NAME,
    expiredAt: new Date().toISOString(),
    error: message,
  });
  await updateJobStatus(job.id, {
    status: 'expired',
    finished_at: new Date(),
    attempts: job.attemptsMade,
    last_error: message,
  });
  return true;
}

async function processOutgoingWhatsapp(job, { getUserBot }) {
  const payload = job.data || {};
  const userId = payload.userId;
  const sender = payload.sender;
  const reply = String(payload.reply || '').trim();
  const replyMessageId = payload.replyMessageId;
  const providerMessageId = payload.providerMessageId;

  if (!userId) throw new Error('Missing userId in outgoing payload');
  if (!sender) throw new Error('Missing sender in outgoing payload');
  if (!reply) throw new Error('Missing reply in outgoing payload');

  // Guard: @lid JIDs have no phone number — Baileys cannot reliably send to them.
  // Attempt a best-effort send anyway (some sessions allow it) and alert the owner
  // if it fails so the customer doesn't fall through the cracks silently.
  if (sender.endsWith('@lid')) {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] @lid sender detected: jid=${sender} replyMessageId=${replyMessageId} userId=${userId}`);
    return handleLidOutgoing({ job, payload, userId, sender, reply, replyMessageId, getUserBot });
  }

  if (await skipStaleOutgoingJob(job, { replyMessageId })) {
    return { skipped: true, reason: 'stale_outgoing_reply' };
  }

  const loadedBot = await getUserBot(userId);
  if (shouldCancelOutgoingForStoppedBot(loadedBot, payload)) {
    const message = 'outgoing reply canceled because bot is stopped by owner';
    await markReplyMessage(replyMessageId, 'canceled', {
      sentBy: WORKER_NAME,
      canceledAt: new Date().toISOString(),
      error: message,
    });
    await updateJobStatus(job.id, {
      status: 'canceled',
      finished_at: new Date(),
      attempts: job.attemptsMade,
      last_error: message,
    });
    return { skipped: true, reason: 'bot_stopped_by_owner' };
  }

  await updateJobStatus(job.id, {
    status: 'processing',
    started_at: new Date(),
    attempts: job.attemptsMade,
  });

  const bot = await waitForConnectedBot(loadedBot, {
    reason: `outgoing:${job.id}`,
    timeoutMs: parseInt(process.env.OUTGOING_WAIT_CONNECTED_MS || '45000', 10),
  });

  // Bail out before sending if the underlying socket is not open. Baileys may report
  // appState=connected briefly even though the websocket has gone idle; sending in
  // that window silently drops the message. Throwing here re-queues the job via BullMQ.
  if (!isSocketOpen(bot)) {
    throw new Error('socket_not_open');
  }

  // Best-effort typing indicator — never block the send if it fails. Route
  // through bot.client so the wrapper resolves the live socket; capturing
  // bot.sock here would pin a dead reference across reconnects.
  try { await bot.client?.sendPresenceUpdate?.('composing', sender); } catch (_) {}

  const sendResult = await sendWhatsappReply(bot, { sender, reply, providerMessageId });
  await recordWhatsappMessageId(userId, replyMessageId, sendResult?.key?.id);

  // Send-only path: quota is decremented only when sendWhatsappReply resolves
  // without throwing. If the send throws (including socket_not_open above), this
  // line is skipped and BullMQ re-queues the job.
  const dec = await decrementMessageQuota(userId);
  if (!dec.success) {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] sent ${replyMessageId} but quota already empty for ${userId}`);
  }

  // Best-effort "stopped typing" — fire and forget.
  try { await bot.client?.sendPresenceUpdate?.('paused', sender); } catch (_) {}

  await markReplyMessage(replyMessageId, 'sent', {
    sentBy: WORKER_NAME,
    sentAt: new Date().toISOString(),
    quotaRemainingAfter: dec.remaining ?? 0,
  });
  await updateJobStatus(job.id, {
    status: 'completed',
    finished_at: new Date(),
    attempts: job.attemptsMade + 1,
    last_error: null,
  });

  bot.log(`outgoing reply sent to ${sender}`);

  // Minimum inter-send pacing. Keeps us under WhatsApp's per-conversation rate
  // limits and gives presence updates time to flush. No Redis lock — single
  // concurrency worker already serializes.
  const pacingMs = parseInt(process.env.OUTGOING_MIN_INTERVAL_MS || '800', 10);
  if (pacingMs > 0) await new Promise(r => setTimeout(r, pacingMs));

  return { sent: true, replyMessageId };
}

function isSocketOpen(bot) {
  // Baileys: bot.sock.ws is a WebSocket with readyState (1=OPEN).
  // whatsapp-web.js: no .sock — accept as open since its own readiness check ran already.
  const sock = bot?.sock;
  if (!sock) return true;
  const ws = sock.ws;
  if (!ws) return true;
  if (typeof ws.readyState !== 'number') return true;
  return ws.readyState === 1;
}

async function handleLidOutgoing({ job, payload, userId, sender, reply, replyMessageId, getUserBot }) {
  // Try a best-effort send first. Some sessions can deliver to @lid even though
  // it's unreliable in general — better to attempt than to silently drop.
  let sendError = null;
  try {
    const loadedBot = await getUserBot(userId);
    if (shouldCancelOutgoingForStoppedBot(loadedBot, payload)) {
      throw new Error('bot_stopped_by_owner');
    }
    const bot = await waitForConnectedBot(loadedBot, {
      reason: `outgoing-lid:${job.id}`,
      timeoutMs: parseInt(process.env.OUTGOING_WAIT_CONNECTED_MS || '45000', 10),
    });
    if (!isSocketOpen(bot)) throw new Error('socket_not_open');
    if (!bot?.client?.sendMessage) throw new Error('no_send_channel_for_lid');
    const lidResult = await bot.client.sendMessage(sender, reply);
    await recordWhatsappMessageId(userId, replyMessageId, lidResult?.key?.id);
    await markReplyMessage(replyMessageId, 'sent', {
      sentBy: WORKER_NAME,
      sentAt: new Date().toISOString(),
      lid: true,
    });
    await updateJobStatus(job.id, {
      status: 'completed',
      finished_at: new Date(),
      attempts: job.attemptsMade + 1,
      last_error: null,
    });
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] @lid best-effort send succeeded jid=${sender}`);
    return { sent: true, replyMessageId, lid: true };
  } catch (err) {
    sendError = err;
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] @lid best-effort send failed jid=${sender}: ${err.message}`);
  }

  await markReplyMessage(replyMessageId, 'skipped_lid', {
    sentBy: WORKER_NAME,
    skippedAt: new Date().toISOString(),
    reason: 'sender_is_lid_only',
    error: sendError?.message || null,
  });

  await notifyOwnerOfLidFailure({ userId, sender, getUserBot }).catch((notifyErr) => {
    console.warn(`${new Date().toISOString()} [${WORKER_NAME}] owner notify for @lid failed: ${notifyErr.message}`);
  });

  return { skipped: true, reason: 'sender_is_lid_only', lid: true };
}

async function notifyOwnerOfLidFailure({ userId, sender, getUserBot }) {
  const ownerPhone = String(process.env.OWNER_ALERT_PHONE || '').replace(/[^\d]/g, '');
  if (!ownerPhone) return false;
  const ownerJid = `${ownerPhone}@s.whatsapp.net`;
  const text = `تعذّر الرد على عميل برقم مخفي (lid: ${sender})`;

  // Use the same bot instance — it's the owner's WhatsApp account, so the alert
  // arrives on the owner's phone alongside normal customer chats.
  const loadedBot = await getUserBot(userId).catch(() => null);
  if (!loadedBot || loadedBot?.appState?.status !== 'connected') return false;
  // Route through bot.client only — bot.sock can hold a stale reference across
  // reconnects, sending to a dead socket throws silently in fire-and-forget
  // contexts.
  if (loadedBot?.client?.sendMessage) {
    await loadedBot.client.sendMessage(ownerJid, text);
    return true;
  }
  return false;
}

function shouldCancelOutgoingForStoppedBot(bot, payload = {}) {
  return bot?.sessionDesiredState === 'stopped' && !payload.escalation;
}

async function sendWhatsappReply(bot, { sender, reply, providerMessageId }) {
  const timeoutMs = TIMERS.SEND_MESSAGE_TIMEOUT_MS;
  return Promise.race([
    sendWhatsappReplyUnchecked(bot, { sender, reply, providerMessageId }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (30s)')), timeoutMs)),
  ]);
}

async function sendWhatsappReplyUnchecked(bot, { sender, reply, providerMessageId }) {
  if (providerMessageId && typeof bot.client.getMessageById === 'function') {
    const original = await bot.client.getMessageById(providerMessageId).catch((err) => {
      bot.log?.(`message reply lookup failed: ${err.message}`);
      return null;
    });
    if (original && typeof original.reply === 'function') {
      return original.reply(reply);
    }
  }

  if (typeof bot.client.getChatById === 'function') {
    const chat = await bot.client.getChatById(sender).catch((err) => {
      bot.log?.(`chat lookup failed for ${sender}: ${err.message}`);
      return null;
    });
    if (chat && typeof chat.sendMessage === 'function') {
      return chat.sendMessage(reply);
    }
  }

  return bot.client.sendMessage(sender, reply);
}

function resolveOutgoingSettleMs(bot) {
  const explicit = process.env.OUTGOING_CONNECTED_SETTLE_MS;
  if (explicit != null && String(explicit).trim() !== '') return parseInt(explicit, 10);
  // Baileys is genuinely connected the moment the socket opens, so a short settle is
  // enough to ride out the post-pairing restart. whatsapp-web.js fires "ready" before the
  // page is fully usable, so it needs a longer settle window.
  return bot?.appState?.whatsappEngine === 'baileys' ? 3000 : 20000;
}

async function waitForConnectedBot(bot, { reason, timeoutMs }) {
  if (!bot) throw new Error('Unable to load user bot');
  if (bot.sessionDesiredState === 'stopped') {
    throw new Error('WhatsApp is stopped by owner');
  }
  const settleMs = resolveOutgoingSettleMs(bot);
  if (bot.appState.status === 'connected' && bot.client && (bot.appState.statusAgeMs || 0) >= settleMs) {
    return bot;
  }

  // Don't force a reconnect while the bot is intentionally backing off after a
  // WhatsApp 440 conflict — doing so defeats the smart backoff and creates a
  // tight reconnect loop. The bot's own 440-recovery timer will reconnect when
  // the backoff window elapses; meanwhile we let BullMQ re-queue this send.
  if (
    bot.sessionDesiredState === 'running' &&
    !bot.isInConnConflictBackoff?.() &&
    ['stopped', 'reconnecting', 'disconnected', 'waiting_qr'].includes(bot.appState.status)
  ) {
    bot.startBot(reason).catch((err) => bot.log?.(`outgoing start failed: ${err.message}`));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bot.appState.status === 'connected' && bot.client) {
      if ((bot.appState.statusAgeMs || 0) >= settleMs) return bot;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  throw new Error(`WhatsApp is not connected (status=${bot.appState.status})`);
}

async function requeuePersistedOutgoingJobs(limit = 200) {
  if (!db.isConfigured()) return;
  const maxAgeMs = parseInt(process.env.OUTGOING_STALE_JOB_MAX_AGE_MS || '600000', 10);

  // Expire outgoing jobs older than the staleness window so a (re)start never
  // resurrects and sends day-old replies to customers. The requeue used to pick
  // up ANY pending job regardless of age, then re-add it with a fresh BullMQ
  // timestamp — bypassing the per-send staleness guard and spamming old chats.
  if (maxAgeMs > 0) {
    await db.query(
      `UPDATE jobs
          SET status = 'expired', updated_at = NOW(),
              last_error = COALESCE(last_error, '') || ' [expired: stale on requeue]'
        WHERE queue_name = $1
          AND created_at <= NOW() - make_interval(secs => $2)
          AND (status IN ('queued', 'processing')
               OR (status = 'failed' AND COALESCE(last_error, '') ILIKE '%not connected%'))`,
      [QUEUE_NAMES.outgoingWhatsapp, maxAgeMs / 1000],
    ).catch((err) => console.warn(`${new Date().toISOString()} [${WORKER_NAME}] expire-stale failed: ${err.message}`));
  }

  const ageClause = maxAgeMs > 0 ? 'AND created_at > NOW() - make_interval(secs => $3)' : '';
  const params = maxAgeMs > 0
    ? [QUEUE_NAMES.outgoingWhatsapp, limit, maxAgeMs / 1000]
    : [QUEUE_NAMES.outgoingWhatsapp, limit];
  const result = await db.query(
    `SELECT job_key, payload
     FROM jobs
     WHERE queue_name = $1
       ${ageClause}
       AND (
         status IN ('queued', 'processing')
         OR (status = 'failed' AND COALESCE(last_error, '') ILIKE '%not connected%')
       )
     ORDER BY created_at ASC
     LIMIT $2`,
    params,
  );
  if (!result.rows.length) return;

  const { outgoingWhatsapp } = getQueues();
  for (const row of result.rows) {
    try {
      const safeJobKey = normalizeOutgoingJobKey(row.job_key, row.payload);
      const existing = safeJobKey ? await outgoingWhatsapp.getJob(safeJobKey).catch(() => null) : null;
      if (existing) {
        if (safeJobKey && safeJobKey !== row.job_key) {
          await updatePersistedJobKey(row.job_key, safeJobKey).catch(() => {});
        }
        const state = await existing.getState().catch(() => null);
        if (state === 'failed') {
          await existing.retry('failed').catch(() => {});
        }
        continue;
      }
      await outgoingWhatsapp.add('send-whatsapp-message', row.payload, {
        jobId: safeJobKey || undefined,
        attempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
        backoff: {
          type: 'exponential',
          delay: parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '15000', 10),
        },
      }).catch((err) => {
        if (!/already exists/i.test(err.message)) throw err;
      });
      if (safeJobKey && safeJobKey !== row.job_key) {
        await updatePersistedJobKey(row.job_key, safeJobKey).catch(() => {});
      }
    } catch (err) {
      console.warn(
        `${new Date().toISOString()} [${WORKER_NAME}] requeue skipped one job (job_key=${row.job_key}): ${err.message}`,
      );
    }
  }
  console.log(`${new Date().toISOString()} [${WORKER_NAME}] requeued ${result.rows.length} persisted outgoing job(s)`);
}

async function updatePersistedJobKey(oldJobKey, newJobKey) {
  if (!db.isConfigured() || !oldJobKey || !newJobKey || oldJobKey === newJobKey) return;
  await db.query(
    `UPDATE jobs
     SET job_key = $3, updated_at = NOW()
     WHERE queue_name = $1 AND job_key = $2
       AND NOT EXISTS (
         SELECT 1 FROM jobs existing
         WHERE existing.queue_name = $1 AND existing.job_key = $3
       )`,
    [QUEUE_NAMES.outgoingWhatsapp, oldJobKey, newJobKey],
  );
}

function createOutgoingWhatsappWorker({ getUserBot }) {
  if (typeof getUserBot !== 'function') throw new Error('getUserBot dependency is required');
  const connection = createRedisConnection();
  const worker = new Worker(
    QUEUE_NAMES.outgoingWhatsapp,
    (job) => processOutgoingWhatsapp(job, { getUserBot }),
    {
      connection,
      concurrency: parseInt(process.env.OUTGOING_WORKER_CONCURRENCY || '1', 10),
      lockDuration: parseInt(process.env.OUTGOING_WORKER_LOCK_DURATION_MS || '60000', 10),
    },
  );

  worker.on('completed', (job) => {
    console.log(`${new Date().toISOString()} [${WORKER_NAME}] completed ${job.id}`);
  });

  worker.on('error', (err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] error: ${err.message}`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] failed ${job?.id}: ${err.message}`);
    if (job?.id) {
      const attemptsLimit = job.opts?.attempts || parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10);
      const waitingForConnection = /not connected|qr|stopped|reconnecting|disconnected|waiting/i.test(err.message);
      const exhausted = !waitingForConnection && job.attemptsMade >= attemptsLimit;
      await updateJobStatus(job.id, {
        status: exhausted ? 'failed' : 'queued',
        last_error: err.message,
        attempts: job.attemptsMade,
      }).catch(() => {});
      await markReplyMessage(job.data?.replyMessageId, exhausted ? 'send_failed' : 'queued_for_send', {
        sentBy: WORKER_NAME,
        failedAt: new Date().toISOString(),
        error: err.message,
      }).catch(() => {});
    }
  });

  requeuePersistedOutgoingJobs().catch((err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] requeue failed: ${err.message}`);
  });

  return worker;
}

module.exports = {
  createOutgoingWhatsappWorker,
  handleLidOutgoing,
  isSocketOpen,
  notifyOwnerOfLidFailure,
  processOutgoingWhatsapp,
  requeuePersistedOutgoingJobs,
  resolveOutgoingSettleMs,
  sendWhatsappReply,
  shouldCancelOutgoingForStoppedBot,
  shouldSkipStaleOutgoingPayload,
  updatePersistedJobKey,
  waitForConnectedBot,
};
