'use strict';

/**
 * Instruction Routing Layer — escalation-rule evaluation (PURE, no I/O).
 *
 * Consumes the STRUCTURED rules the router stored (config.escalationRules) at
 * reply time so escalation is DETERMINISTIC — it fires from a matched trigger and
 * a resolved contact, not from hoping the LLM emits a [تحويل:] marker. A rule
 * whose target no longer resolves to a real destination is reported as
 * `unresolved` so the caller can prompt the merchant instead of firing a broken
 * escalation or promising the customer a transfer nobody receives.
 */

const { normalizeArabic, contactHasDestination, contactStableId } = require('./instruction-router');

function resolveContactById(contacts, id) {
  const list = Array.isArray(contacts) ? contacts : [];
  const want = String(id || '').trim();
  if (!want) return null;
  return list.find((c) => c && (String(c.id || '').trim() === want || contactStableId(c) === want)) || null;
}

function triggerMatches(rule, { norm, intent, slaBreached }) {
  const value = normalizeArabic(rule && rule.trigger_value);
  switch (rule && rule.trigger_type) {
    case 'topic':
    case 'keyword':
      return Boolean(value) && norm.includes(value);
    case 'intent':
      return Boolean(value) && String(intent || '') === String(rule.trigger_value || '');
    case 'sla_breach':
      // The breach itself is computed deterministically upstream (sla-breach.js);
      // here we only fire when the caller has already confirmed a real breach.
      return slaBreached === true;
    // system_state is evaluated by its own engine (not here).
    default:
      return false;
  }
}

/**
 * Evaluate the tenant's escalation rules against the current inbound.
 * Returns { matched:false } or { matched:true, rule, contact } — or, when the
 * matched rule's target no longer resolves, { matched:true, rule, contact:null,
 * unresolved:true }. First matching rule wins.
 */
function evaluateEscalationRules(config = {}, { text, intent, slaBreached } = {}) {
  const rules = Array.isArray(config.escalationRules) ? config.escalationRules : [];
  const contacts = Array.isArray(config.escalationContacts) ? config.escalationContacts : [];
  const norm = normalizeArabic(text || '');
  for (const rule of rules) {
    if (!triggerMatches(rule, { norm, intent, slaBreached })) continue;
    const contact = resolveContactById(contacts, rule.target_contact_id);
    if (contact && contactHasDestination(contact)) return { matched: true, rule, contact };
    return { matched: true, rule, contact: null, unresolved: true };
  }
  return { matched: false };
}

/**
 * If a stored escalation rule matches the current inbound and its target is
 * resolvable, ensure the reply carries an escalation marker so the EXISTING
 * (tested) escalation machinery fires deterministically — no reliance on the LLM
 * volunteering it. Never double-marks (respects a marker the model already
 * emitted) and never fires on an unresolved target (that stays a merchant
 * setup task, not a broken/again-silent escalation).
 */
function applyDeterministicEscalation(reply, config = {}, { text, intent, slaBreached } = {}) {
  const base = String(reply || '');
  const r = evaluateEscalationRules(config, { text, intent, slaBreached });
  if (!r.matched) return { reply: base, escalated: false };
  if (r.unresolved || !r.contact) return { reply: base, escalated: false, unresolved: true, rule: r.rule };
  if (/\[تحويل:/.test(base)) return { reply: base, escalated: false, alreadyMarked: true };
  const summary = r.rule.trigger_value
    || (r.rule.trigger_type === 'sla_breach' ? 'تجاوز مهلة الـSLA' : 'طلب من العميل');
  const marker = `[تحويل:${r.contact.name}|${summary}]`;
  return { reply: `${base} ${marker}`.trim(), escalated: true, contact: r.contact, rule: r.rule };
}

module.exports = { evaluateEscalationRules, resolveContactById, triggerMatches, applyDeterministicEscalation };
