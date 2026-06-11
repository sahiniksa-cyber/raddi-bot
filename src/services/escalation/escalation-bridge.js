'use strict';

// Two-way escalation bridge. When the AI escalates a problem to the platform
// group (or a contact), the team member quote-replies the escalation message
// with the solution — and the bot relays it to the customer and keeps the
// channel open: customer replies are forwarded back to the team while the
// thread is active. The mapping key is the WhatsApp message id of every
// bot→team message (escalation_threads table).

const dbDefault = require('../../db/client');
const { enqueueOutgoingWhatsapp } = require('../../queues/message-queue');

const BRIDGE_WINDOW_MS = parseInt(process.env.ESCALATION_BRIDGE_WINDOW_MS || String(60 * 60 * 1000), 10);

async function recordThreadMessage({
  database = dbDefault,
  userId,
  whatsappMessageId,
  targetJid,
  customerSender,
  conversationId = null,
} = {}) {
  if (!userId || !whatsappMessageId || !targetJid || !customerSender) return false;
  if (!database?.isConfigured?.()) return false;
  await database.query(
    `INSERT INTO escalation_threads (user_id, whatsapp_message_id, target_jid, customer_sender, conversation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, whatsapp_message_id) DO NOTHING`,
    [userId, String(whatsappMessageId), targetJid, customerSender, conversationId],
  );
  return true;
}

async function findThreadByQuotedId({ database = dbDefault, userId, quotedId } = {}) {
  if (!userId || !quotedId || !database?.isConfigured?.()) return null;
  const result = await database.query(
    `SELECT id, customer_sender, target_jid, conversation_id
       FROM escalation_threads
      WHERE user_id = $1 AND whatsapp_message_id = $2
      LIMIT 1`,
    [userId, String(quotedId)],
  );
  return result.rows[0] || null;
}

async function findActiveThreadForCustomer({
  database = dbDefault,
  userId,
  customerSender,
  windowMs = BRIDGE_WINDOW_MS,
} = {}) {
  if (!userId || !customerSender || !database?.isConfigured?.()) return null;
  const result = await database.query(
    `SELECT id, customer_sender, target_jid, conversation_id
       FROM escalation_threads
      WHERE user_id = $1 AND customer_sender = $2
        AND created_at > NOW() - ($3 * interval '1 millisecond')
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, customerSender, windowMs],
  );
  return result.rows[0] || null;
}

// The team member's quoted reply IS the customer-facing answer — relay it
// verbatim through the standard outgoing pipeline (status flow, quota, retry)
// but with zero humanization delay: it's a fix, not small talk.
async function relayResolutionToCustomer({
  database = dbDefault,
  enqueue = enqueueOutgoingWhatsapp,
  userId,
  thread,
  text,
  authorJid = null,
  windowMs = BRIDGE_WINDOW_MS,
} = {}) {
  const reply = String(text || '').trim();
  if (!reply || !userId || !thread?.customer_sender) return { relayed: false };
  if (!database?.isConfigured?.()) return { relayed: false };

  const providerMessageId = `bridge:${thread.id || 'x'}:${Date.now()}`;
  const inserted = await database.query(
    `INSERT INTO messages (conversation_id, user_id, sender, direction, role, content, provider_message_id, status, raw_payload)
     VALUES ($1, $2, $3, 'outbound', 'assistant', $4, $5, 'queued_for_send', $6::jsonb)
     RETURNING id`,
    [
      thread.conversation_id || null,
      userId,
      thread.customer_sender,
      reply,
      providerMessageId,
      JSON.stringify({ escalationBridge: true, relayedBy: authorJid, targetJid: thread.target_jid }),
    ],
  );
  const replyMessageId = inserted.rows[0]?.id || null;

  await enqueue({
    userId,
    conversationId: thread.conversation_id || null,
    sender: thread.customer_sender,
    reply,
    replyMessageId,
    source: 'escalation_bridge',
  }, {
    jobKey: replyMessageId ? String(replyMessageId) : `bridge-${Date.now()}`,
    delay: 0,
  });

  // The team member owns this conversation now — keep the AI quiet for the
  // bridge window so they can go back and forth without interference.
  if (thread.conversation_id) {
    await database.query(
      `UPDATE conversations SET escalated_until = NOW() + ($2 * interval '1 millisecond') WHERE id = $1`,
      [thread.conversation_id, windowMs],
    ).catch(() => {});
  }

  return { relayed: true, replyMessageId };
}

function buildCustomerForwardText({ customerSender, text } = {}) {
  const digits = String(customerSender || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
  return [
    `💬 رد العميل${digits ? ` (+${digits})` : ''}:`,
    String(text || '').trim(),
    '',
    'للرد عليه: رد على هذه الرسالة بالحل وسيصله مباشرة.',
  ].join('\n');
}

// While a thread is active, the customer's replies are forwarded to the team
// target as quotable messages (escalation:true + customerSender makes the
// outgoing worker record them as thread rows too — so the team can quote the
// forward itself, not just the original escalation).
async function forwardCustomerReplyToTeam({
  enqueue = enqueueOutgoingWhatsapp,
  userId,
  thread,
  customerSender,
  text,
} = {}) {
  const body = String(text || '').trim();
  if (!body || !userId || !thread?.target_jid) return { forwarded: false };
  await enqueue({
    userId,
    conversationId: thread.conversation_id || null,
    sender: thread.target_jid,
    reply: buildCustomerForwardText({ customerSender, text: body }),
    escalation: true,
    customerSender,
    source: 'escalation_bridge_forward',
  }, {
    jobKey: `bridge-fwd-${userId}-${Date.now()}`,
    delay: 0,
  });
  return { forwarded: true };
}

module.exports = {
  recordThreadMessage,
  findThreadByQuotedId,
  findActiveThreadForCustomer,
  relayResolutionToCustomer,
  forwardCustomerReplyToTeam,
  buildCustomerForwardText,
  BRIDGE_WINDOW_MS,
};
