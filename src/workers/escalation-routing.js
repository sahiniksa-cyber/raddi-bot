'use strict';

const {
  requireActiveMerchantPolicy,
} = require('../services/ai/canonical-prompt-context');

const MARKER_RE = /\[تحويل:([^|\]\n]+)\|([^\]\n]+)\]/;

// Defensive scrub: strip ANY [تحويل:...] residue — well-formed (WITH a pipe) or
// MALFORMED (without one, e.g. "[تحويل:المالك]"). MARKER_RE only matches the
// piped form, so a malformed marker would otherwise survive into the customer
// reply and leak internal routing text to the customer (CX-1). The escalation
// bridge already scrubs on its side; this guarantees the main path too.
function stripEscalationMarkers(text) {
  return String(text || '')
    .replace(/\[تحويل:[^\]]*\]/g, '')   // bracketed marker, any inner content
    .replace(/\[تحويل:[^\n]*$/m, '')    // unterminated marker (missing ]) to line end
    .trim();
}

function cleanDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function normalizeEscalationPhone(phone) {
  let digits = cleanDigits(phone);
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = `966${digits.slice(1)}`;
  return `${digits}@c.us`;
}

// Longest real phone number is 15 digits (E.164); WhatsApp group ids are 18+.
// A bare digit string at or past this length can only be a group id pasted
// without its @g.us suffix.
const GROUP_ID_MIN_DIGITS = 16;

function normalizeEscalationTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;
  if (raw.endsWith('@g.us') || raw.endsWith('@c.us') || raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) return raw;
  const digits = cleanDigits(raw);
  if (digits && digits === raw.replace(/[\s+-]/g, '') && digits.length >= GROUP_ID_MIN_DIGITS) {
    return `${digits}@g.us`;
  }
  return normalizeEscalationPhone(raw);
}

function extractEscalationRequest(reply) {
  const text = String(reply || '');
  const match = text.match(MARKER_RE);
  if (!match) return null;

  return {
    customerReply: text.replace(MARKER_RE, '').trim(),
    contactName: match[1].trim(),
    summary: match[2].trim(),
  };
}

function normalizeArabic(value) {
  return String(value || '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldEscalateByContactRule(contact, inboundText) {
  const rule = normalizeArabic(contact?.when || '');
  const text = normalizeArabic(inboundText || '');
  if (!rule || !text) return false;

  const stop = new Set(['اي', 'احد', 'عن', 'اذا', 'متى', 'يسال', 'سالك', 'سأل', 'اشتراك', 'مشكله', 'مشاكل', 'شي']);
  const tokens = rule.split(' ').filter(token => token.length >= 4 && !stop.has(token));
  return tokens.some(token => text.includes(token));
}

function resolveEscalationContact(config = {}, contactId) {
  let compiled;
  try {
    compiled = requireActiveMerchantPolicy(config);
  } catch (_) {
    return null;
  }
  const canonical = compiled.indexes.contactsById[String(contactId || '').trim()] || null;
  const contact = canonical
    ? {
      id: canonical.id,
      name: canonical.name,
      phone: canonical.phoneNumber,
      target: canonical.phoneNumber,
    }
    : null;
  if (!contact) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `${new Date().toISOString()} [escalation] no canonical contact id matched; canceling escalation`,
      );
    } catch (_) {}
    return null;
  }
  return contact;
}

function cleanCustomerJid(sender, { phoneNumber } = {}) {
  const pn = String(phoneNumber || '').trim();
  if (pn) return `+${pn}`;
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) {
    const digits = raw.replace(/@lid$/, '').replace(/[^\d]/g, '');
    const last4 = digits.slice(-4);
    return last4 ? `عميل ····${last4}` : 'عميل قديم';
  }
  return cleanDigits(sender) || raw;
}

function applyEscalationTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*(contactName|contactRole|customerPhone|customerMessage|summary)\s*\}\}/g, (_, key) => {
    return values[key] || '';
  }).trim();
}

function buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }) {
  const customer = cleanCustomerJid(customerSender, { phoneNumber: customerPhoneNumber });
  const customerMessage = String(inboundText || '').trim() || 'غير متوفرة';
  const problemSummary = String(summary || '').trim() || 'يحتاج متابعة';
  if (contact?.messageTemplate?.trim()) {
    const templated = applyEscalationTemplate(contact.messageTemplate, {
      contactName: contact?.name || '',
      contactRole: contact?.role || '',
      customerPhone: customer || 'غير معروف',
      customerMessage,
      summary: problemSummary,
    });
    if (templated) return templated;
  }

  const role = contact?.role ? ` (${contact.role})` : '';
  return [
    `تنبيه تحويل لخدمة العملاء${contact?.name ? ` - ${contact.name}${role}` : ''}`,
    `رقم العميل: ${customer || 'غير معروف'}`,
    `رسالة العميل: ${customerMessage}`,
    `المشكلة: ${problemSummary}`,
  ].join('\n');
}

function prepareEscalation({ reply, config = {}, customerSender, customerPhoneNumber, inboundText }) {
  const explicit = extractEscalationRequest(reply);
  // Normal customer replies have no internal transfer marker. Return before
  // resolving contacts so routine messages cannot trigger misleading
  // "no contact matched" warnings or any rule-based side effects.
  if (!explicit) {
    return {
      customerReply: stripEscalationMarkers(reply),
      ownerMessage: null,
    };
  }
  const contact = resolveEscalationContact(config, explicit?.contactName, inboundText);
  // Only escalate on the AI's explicit [تحويل:...] tag. A customer keyword match
  // alone is NOT enough — it caused the owner to be spammed for routine questions.
  // Always scrub: catches a malformed marker in the fallback path AND any second
  // (malformed) marker left behind in explicit.customerReply (CX-1).
  const customerReply = stripEscalationMarkers(explicit?.customerReply || reply);

  const contactTarget = contact?.target || contact?.jid || contact?.groupJid || contact?.phone;
  if (!contactTarget) {
    return { customerReply, ownerMessage: null };
  }

  const target = normalizeEscalationTarget(contactTarget);
  const summary = explicit?.summary || `قاعدة التحويل: ${contact.when || contact.role || contact.name || 'متابعة مطلوبة'}`;

  if (!target) {
    // Not a phone and not a JID — merchants type the GROUP NAME here because
    // WhatsApp never shows them the literal @g.us id. Pass the raw name
    // through; the outgoing worker (the only process holding a live socket)
    // resolves it against the account's joined groups at send time.
    const rawName = String(contactTarget).trim();
    if (!rawName) return { customerReply, ownerMessage: null };
    return {
      customerReply,
      ownerMessage: {
        sender: rawName,
        needsGroupResolution: true,
        reply: buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }),
        contact,
        summary,
        contactTarget: rawName,
      },
    };
  }

  return {
    customerReply,
    ownerMessage: {
      sender: target,
      reply: buildEscalationNotification({ contact, customerSender, customerPhoneNumber, inboundText, summary }),
      contact,
      summary,
      contactTarget: target,
    },
  };
}

module.exports = {
  buildEscalationNotification,
  extractEscalationRequest,
  normalizeArabic,
  normalizeEscalationPhone,
  normalizeEscalationTarget,
  prepareEscalation,
  applyEscalationTemplate,
  stripEscalationMarkers,
};
