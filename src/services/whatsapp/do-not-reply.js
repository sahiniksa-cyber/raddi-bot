'use strict';

/**
 * Per-merchant "do-not-reply" list. Matching is by PHONE NUMBER only — the name
 * a merchant stores alongside an entry is just a human label and never affects
 * matching, so two different people who happen to share a WhatsApp name can't be
 * blocked by mistake.
 *
 * normalizeNumber reduces any phone/jid representation to its national-significant
 * digits so the same person matches regardless of format:
 *   +966501234567, 00966501234567, 966501234567, 0501234567, 501234567,
 *   966501234567@c.us, 966501234567@s.whatsapp.net, 966501234567:12@... → "501234567"
 */
function normalizeNumber(input) {
  let s = String(input == null ? '' : input);
  s = s.split('@')[0].split(':')[0]; // drop jid host and :device suffix
  let d = s.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = d.slice(1); // Saudi local 0XXXXXXXXX
  if (d.startsWith('966')) d = d.slice(3); // drop country code
  return d;
}

/**
 * Is this inbound sender on the merchant's do-not-reply list?
 * @param {object} config  merchant config (reads config.doNotReplyList)
 * @param {string} sender  WhatsApp jid (e.g. "966501234567@s.whatsapp.net")
 * @param {string} phoneNumber  raw phone if available
 * @returns {boolean}
 */
function isCustomerBlocked(config = {}, sender = '', phoneNumber = '') {
  const list = Array.isArray(config && config.doNotReplyList) ? config.doNotReplyList : [];
  if (!list.length) return false;

  const candidates = [normalizeNumber(sender), normalizeNumber(phoneNumber)].filter(Boolean);
  if (!candidates.length) return false;

  return list.some((entry) => {
    const raw = entry && typeof entry === 'object' ? entry.number : entry;
    const target = normalizeNumber(raw);
    if (!target || target.length < 6) return false; // ignore blank/garbage entries
    return candidates.some(
      (c) => c === target || (c.length >= 9 && target.length >= 9 && c.slice(-9) === target.slice(-9)),
    );
  });
}

module.exports = { isCustomerBlocked, normalizeNumber };
