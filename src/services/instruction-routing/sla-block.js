'use strict';

/**
 * Instruction Routing Layer — SLA prompt block (PURE, no I/O).
 *
 * Renders the structured config.slaPolicies (captured by the router) as an
 * authoritative, non-inventable time-fact block. This turns an SLA from a
 * sentence the LLM parrots (and may get wrong) into a stable fact the reply must
 * state consistently. Computing whether a SPECIFIC order is late needs the order
 * timeline (Decision Context); this block covers the policy statement itself.
 */

function buildSlaBlock(slaPolicies) {
  const list = Array.isArray(slaPolicies) ? slaPolicies.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = list.map((p) => {
    const text = String(p.source_text || '').trim();
    if (text) return `- ${text}`;
    const amount = p.amount != null ? p.amount : '';
    const unit = String(p.unit || '').trim();
    return `- ${amount} ${unit}`.trim();
  });
  return `\n\n⏱️ سياسات الوقت (SLA) — مواعيد رسمية ثابتة، اذكرها كما هي ولا تخترع مدداً غيرها:\n${lines.join('\n')}`;
}

module.exports = { buildSlaBlock };
