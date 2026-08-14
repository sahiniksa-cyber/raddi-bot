'use strict';

/**
 * Instruction Routing Layer — apply (PURE, no I/O).
 *
 * Turns a routing decision (from instruction-router) into EITHER a structured
 * config write or a merchant-facing clarification. Two invariants:
 *   1. Operational content NEVER lands in botInstructions — each operational
 *      category has its own structured field.
 *   2. Nothing is stored silently: an unresolvable escalation target or any
 *      low-confidence/unknown edit returns a clarification and stores nothing.
 *
 * Returns { stored, field, value, merchantReply, action }.
 *   - stored=true  → the caller writes `value` to config.`field` (one jsonb field).
 *   - stored=false → the caller sends `merchantReply` and writes nothing.
 */

function arr(v) { return Array.isArray(v) ? v.slice() : []; }
function nowIso() { return null; } // timestamps are stamped by the I/O caller (pure module stays deterministic)

function clarify(merchantReply) {
  return { stored: false, field: null, value: null, merchantReply, action: 'clarify' };
}

function store(field, value, merchantReply) {
  return { stored: true, field, value, merchantReply, action: 'store' };
}

// Each operational sink → its dedicated structured config field. Prompt
// consumption of the newer fields is added in later slices; routing them here
// keeps operational intent OUT of the free-text prompt today.
const SINK_FIELD = {
  slaPolicy: 'slaPolicies',
  policy: 'tenantPolicies',
  actionPolicy: 'actionRequests',
  avoidPhrases: 'prohibitions',
  products: 'pendingKnowledge',
};

function applyRoutingDecision(decision, config = {}) {
  if (!decision || !decision.sink) return clarify('ما فهمت التعديل، توضّح أكثر؟');
  const cfg = config && typeof config === 'object' ? config : {};

  switch (decision.sink) {
    case 'escalationRule': {
      const rule = {
        target_contact_id: decision.targetContactId,
        trigger_type: decision.trigger && decision.trigger.trigger_type,
        trigger_value: decision.trigger && decision.trigger.trigger_value,
        created_at: nowIso(),
      };
      const value = [...arr(cfg.escalationRules), rule];
      const tv = rule.trigger_value ? ` (${rule.trigger_value})` : '';
      return store('escalationRules', value, `تمام، سجّلت قاعدة تصعيد إلى «${decision.targetName}»${tv}.`);
    }

    case 'botInstructions': {
      const base = String(cfg.botInstructions || '').trim();
      const line = String(decision.line || '').trim();
      const value = base ? `${base}\n${line}` : line;
      return store('botInstructions', value, 'تمام، حدّثت أسلوب الرد.');
    }

    case 'slaPolicy': {
      const entry = {
        amount: decision.duration && decision.duration.amount,
        unit: decision.duration && decision.duration.unit,
        source_text: decision.line || '',
        created_at: nowIso(),
      };
      return store('slaPolicies', [...arr(cfg.slaPolicies), entry],
        'تمام، سجّلتها كسياسة زمنية (SLA) قابلة للحساب.');
    }

    case 'policy':
    case 'actionPolicy':
    case 'avoidPhrases':
    case 'products': {
      const field = SINK_FIELD[decision.sink];
      const entry = { text: decision.line || '', created_at: nowIso() };
      if (decision.sink === 'actionPolicy') entry.requires_tool = true;
      return store(field, [...arr(cfg[field]), entry], 'تمام، سجّلتها في مكانها المنظّم.');
    }

    case 'escalation': {
      if (decision.op === 'needs_target_setup') {
        return clarify(`أضِف رقم أو قروب الجهة «${decision.targetName}» في إعدادات التصعيد أولاً، وبعدها أوجّه لها مباشرة.`);
      }
      if (decision.reason === 'ambiguous_target') {
        return clarify(`عندي أكثر من جهة بنفس الاسم «${decision.targetName}» — حدّد أيّها بالرقم أو المعرّف.`);
      }
      return clarify('لمن أوجّه التصعيد؟ حدّد اسم الجهة أو رقمها.');
    }

    case 'review':
    default:
      return clarify('ما قدرت أصنّف التعديل بثقة كافية — صِغه بشكل أوضح (أسلوب؟ تصعيد؟ سياسة؟).');
  }
}

module.exports = { applyRoutingDecision, SINK_FIELD };
