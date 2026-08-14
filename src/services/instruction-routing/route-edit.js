'use strict';

/**
 * Instruction Routing Layer — edit composer (PURE, no I/O).
 *
 * Composes classify → route → apply for a whole merchant edit body and returns
 * ONE handled outcome the service can act on:
 *   { kind: 'store',   field, value, summary }  → write value to config.field (two-step confirm)
 *   { kind: 'clarify', message }                → send message, store nothing
 *   null                                        → no operational content; let the
 *                                                 legacy prompt path handle it (pure style)
 *
 * Guardrails: operational content never returns a botInstructions store; a mixed
 * edit (operational + anything else, or multiple operational parts) asks the
 * merchant to split it so nothing is lost or misrouted.
 */

const { classifyInstruction } = require('./instruction-classifier');
const { routeInstruction } = require('./instruction-router');
const { applyRoutingDecision } = require('./routing-apply');

function isOperationalSegment(seg) {
  return Boolean(seg && (seg.isOperational || seg.category === 'UNKNOWN'));
}

function routeEditBody(body, config = {}) {
  const segments = classifyInstruction(body);
  if (!segments.length) return null;

  const operational = segments.filter(isOperationalSegment);
  if (!operational.length) return null; // pure style / nothing operational → legacy prompt path

  // Operational content mixed with other segments (or several operational parts)
  // → ask to split, so a style part isn't lost and two sinks aren't guessed.
  if (segments.length > 1) {
    return {
      kind: 'clarify',
      message: 'أرسل كل تعليمة في رسالة منفصلة (أسلوب / تصعيد / سياسة / وقت) حتى أوجّه كل واحدة لمكانها الصحيح بدقّة.',
    };
  }

  const out = applyRoutingDecision(routeInstruction(segments[0], config), config);
  if (!out.stored) return { kind: 'clarify', message: out.merchantReply };
  if (out.field === 'botInstructions') return null; // never route operational text here
  return { kind: 'store', field: out.field, value: out.value, summary: out.merchantReply };
}

module.exports = { routeEditBody, isOperationalSegment };
