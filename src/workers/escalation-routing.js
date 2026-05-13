'use strict';

const MARKER_RE = /\[تحويل:([^|\]\n]+)\|([^\]\n]+)\]/;

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

function extractOwnerPhoneFromInstructions(config = {}) {
  const text = String(config.botInstructions || '');
  const match = text.match(/(?:\+?966|05)\d[\d\s-]{7,12}/);
  return match ? match[0] : null;
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

function resolveEscalationContact(config = {}, contactName, inboundText = '') {
  const contacts = Array.isArray(config.escalationContacts) ? config.escalationContacts : [];
  const wanted = normalizeArabic(contactName);
  const byName = wanted
    ? contacts.find(contact => normalizeArabic(contact.name).includes(wanted) || wanted.includes(normalizeArabic(contact.name)))
    : null;
  const byRule = contacts.find(contact => shouldEscalateByContactRule(contact, inboundText));
  const contact = byName || byRule || contacts[0] || null;
  if (contact?.phone) return contact;

  const fallbackPhone = extractOwnerPhoneFromInstructions(config);
  if (fallbackPhone) {
    return { name: contactName || 'المالك', role: 'المالك', phone: fallbackPhone, when: 'تعليمات البوت' };
  }
  return contact;
}

function cleanCustomerJid(sender) {
  const raw = String(sender || '').trim();
  if (raw.endsWith('@lid')) return raw;
  return cleanDigits(sender) || String(sender || '').trim();
}

function buildEscalationNotification({ contact, customerSender, inboundText, summary }) {
  const customer = cleanCustomerJid(customerSender);
  const role = contact?.role ? ` (${contact.role})` : '';
  return [
    `تنبيه تحويل لخدمة العملاء${contact?.name ? ` - ${contact.name}${role}` : ''}`,
    `رقم العميل: ${customer || 'غير معروف'}`,
    `رسالة العميل: ${String(inboundText || '').trim() || 'غير متوفرة'}`,
    `المشكلة: ${String(summary || '').trim() || 'يحتاج متابعة'}`,
  ].join('\n');
}

function prepareEscalation({ reply, config = {}, customerSender, inboundText }) {
  const explicit = extractEscalationRequest(reply);
  const contact = resolveEscalationContact(config, explicit?.contactName, inboundText);
  const ruleMatched = !explicit && contact && shouldEscalateByContactRule(contact, inboundText);
  const shouldSend = explicit || ruleMatched;
  const customerReply = explicit?.customerReply || String(reply || '').trim();

  if (!shouldSend || !contact?.phone) {
    return { customerReply, ownerMessage: null };
  }

  const target = normalizeEscalationPhone(contact.phone);
  if (!target) return { customerReply, ownerMessage: null };

  const summary = explicit?.summary || `قاعدة التحويل: ${contact.when || contact.role || contact.name || 'متابعة مطلوبة'}`;
  return {
    customerReply,
    ownerMessage: {
      sender: target,
      reply: buildEscalationNotification({ contact, customerSender, inboundText, summary }),
      contact,
      summary,
    },
  };
}

module.exports = {
  buildEscalationNotification,
  extractEscalationRequest,
  normalizeEscalationPhone,
  prepareEscalation,
};
