'use strict';

/**
 * Generic, tenant-agnostic conversation-state primitives (PURE — no I/O).
 *
 * The state vocabulary is deliberately abstract: an "issue" is anything
 * (a login, a shipment, a booking, a payment, a subscription, a technical
 * fault) — the engine never knows or encodes a vertical. This module is the
 * single source of the state shape, its validation, the extraction request,
 * system-state reconciliation, the prompt block, and the two deterministic
 * guard helpers. Everything here is synchronous and unit-testable without a
 * database or an LLM.
 */

const EMPTY_STATE = Object.freeze({
  open_issues: [],
  resolved_issues: [],
  active_topic: null,
  active_entity: null,
  known_facts: {},
  customer_goal: null,
  actions_attempted: [],
  last_reply_intent: null,
});

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function str(v) {
  return v == null ? null : String(v).slice(0, 400);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}

function validateIssue(x) {
  const o = plainObject(x);
  if (!o) return null;
  const issue = {
    id: str(o.id) || null,
    summary: str(o.summary) || '',
    status: ['open', 'in_progress'].includes(o.status) ? o.status : 'open',
  };
  if (['customer_confirmed', 'owner'].includes(o.resolved_by)) issue.resolved_by = o.resolved_by;
  if (o.resolved_at != null) issue.resolved_at = str(o.resolved_at);
  if (o.first_seen_at != null) issue.first_seen_at = str(o.first_seen_at);
  return issue;
}

function validateEntity(x) {
  const o = plainObject(x);
  if (!o) return null;
  const type = ['product', 'order', 'service', 'topic'].includes(o.type) ? o.type : null;
  if (!type) return null;
  return { type, ref: str(o.ref) || null, label: str(o.label) || null };
}

function validateAction(x) {
  const o = plainObject(x);
  if (!o) return null;
  return {
    action: str(o.action) || '',
    outcome: ['worked', 'failed', 'unknown'].includes(o.outcome) ? o.outcome : 'unknown',
    confirmed_by: ['customer', 'system'].includes(o.confirmed_by) ? o.confirmed_by : null,
  };
}

function validateFacts(x) {
  const o = plainObject(x);
  if (!o) return {};
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[String(k).slice(0, 60)] = str(v);
    }
  }
  return out;
}

function validateState(input) {
  const o = plainObject(input) || {};
  return {
    open_issues: arr(o.open_issues).map(validateIssue).filter(Boolean),
    resolved_issues: arr(o.resolved_issues).map(validateIssue).filter(Boolean),
    active_topic: str(o.active_topic),
    active_entity: validateEntity(o.active_entity),
    known_facts: validateFacts(o.known_facts),
    customer_goal: str(o.customer_goal),
    actions_attempted: arr(o.actions_attempted).map(validateAction).filter(Boolean),
    last_reply_intent: str(o.last_reply_intent),
  };
}

function parseExtractionResponse(text) {
  const raw = String(text == null ? '' : text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { state: EMPTY_STATE, extraction_ok: false };
  }
  if (!plainObject(parsed)) return { state: EMPTY_STATE, extraction_ok: false };
  return { state: validateState(parsed), extraction_ok: true };
}

module.exports = { EMPTY_STATE, validateState, parseExtractionResponse };
