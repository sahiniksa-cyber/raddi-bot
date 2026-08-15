'use strict';

/**
 * Instruction Routing Layer — SLA breach computation (PURE, no I/O).
 *
 * Turns a stored SLA policy (a stated window like "التفعيل حتى 12 ساعة") plus a
 * RELIABLE system timestamp for when the customer's request started being tracked
 * into a DETERMINISTIC breach verdict. This is what stops the bot from parroting
 * "يأخذ حتى 12 ساعة" as if the window is still ahead when 25 hours have already
 * passed.
 *
 * Authority is: system facts > computed time > request status > tenant policy >
 * conversation state > LLM. The LLM never invents or computes the elapsed time —
 * this module does, from a real DB timestamp only.
 *
 * SAFETY: if there is no reliable anchor timestamp, or no parseable SLA window,
 * NOTHING is claimed (computable=false, sla_breached=false). And with MULTIPLE
 * policies a breach is asserted ONLY when every stated window has already passed —
 * so an unrelated still-valid window can never make us falsely tell a customer
 * their request is late.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const UNIT_MS = {
  'دقيقة': MINUTE, 'دقيقه': MINUTE, 'دقائق': MINUTE,
  'ساعة': HOUR, 'ساعه': HOUR, 'ساعات': HOUR,
  'يوم': DAY, 'أيام': DAY, 'ايام': DAY,
  'أسبوع': WEEK, 'اسبوع': WEEK, 'أسابيع': WEEK, 'اسابيع': WEEK,
};

// Same duration vocabulary the router captures (extractDuration), kept in sync so
// a policy stored from a merchant sentence can be re-parsed from its source_text.
const DURATION_RE = /(\d+)\s*(دقيقة|دقيقه|دقائق|ساعة|ساعه|ساعات|يوم|أيام|ايام|أسبوع|اسبوع|أسابيع|اسابيع)/;

function parseSlaDurationMs(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const amount = Number(policy.amount);
  const unit = String(policy.unit || '').trim();
  if (Number.isFinite(amount) && amount > 0 && UNIT_MS[unit]) {
    return amount * UNIT_MS[unit];
  }
  // Fall back to re-parsing the original sentence.
  const m = String(policy.source_text || '').match(DURATION_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    const u = UNIT_MS[m[2]];
    if (Number.isFinite(n) && n > 0 && u) return n * u;
  }
  return null;
}

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function humanizeMs(ms) {
  const abs = Math.max(0, Math.round(ms));
  if (abs >= DAY) {
    const d = Math.floor(abs / DAY);
    const h = Math.round((abs % DAY) / HOUR);
    return h ? `${d} يوم و${h} ساعة` : `${d} يوم`;
  }
  if (abs >= HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs % HOUR) / MINUTE);
    return m ? `${h} ساعة و${m} دقيقة` : `${h} ساعة`;
  }
  const m = Math.max(1, Math.round(abs / MINUTE));
  return `${m} دقيقة`;
}

/**
 * Compute an SLA breach verdict.
 *
 * @param {object} args
 * @param {Date|number|string|null} args.since - RELIABLE system timestamp for when
 *   the tracked request started (e.g. escalation thread created_at). NOT an
 *   LLM-extracted or customer-claimed time.
 * @param {number} args.now - current epoch ms.
 * @param {Array} args.slaPolicies - stored SLA policies ({ amount, unit, source_text }).
 * @returns {object} time model. Always includes { computable, sla_breached }.
 */
function computeSlaBreach({ since, now, slaPolicies } = {}) {
  const nowMs = toMs(now);
  const sinceMs = toMs(since);
  const policies = Array.isArray(slaPolicies) ? slaPolicies : [];

  const parsed = policies
    .map((p) => ({ policy: p, ms: parseSlaDurationMs(p) }))
    .filter((x) => Number.isFinite(x.ms) && x.ms > 0);

  if (sinceMs == null || nowMs == null || parsed.length === 0) {
    return { computable: false, sla_breached: false };
  }

  const elapsed_ms = nowMs - sinceMs;
  const withState = parsed.map((x) => ({
    ...x,
    breached: elapsed_ms > x.ms,
    text: String(x.policy.source_text || '').trim() || humanizeMs(x.ms),
  }));

  // Conservative: a breach is asserted only when EVERY stated window has already
  // passed. With a single policy this is just that policy; with several it means
  // the request is late under any interpretation of which policy applies.
  const allBreached = withState.every((x) => x.breached);
  const sla_breached = allBreached && elapsed_ms > 0;

  // The window that (all) must exceed = the longest one.
  const longest = withState.reduce((a, b) => (b.ms > a.ms ? b : a), withState[0]);

  return {
    computable: true,
    sla_breached,
    created_at: new Date(sinceMs).toISOString(),
    elapsed_ms,
    elapsed_human: humanizeMs(elapsed_ms),
    expected_sla_ms: longest.ms,
    expected_sla_human: humanizeMs(longest.ms),
    sla_deadline: new Date(sinceMs + longest.ms).toISOString(),
    breached_policies: sla_breached ? withState.map((x) => x.text) : [],
  };
}

/**
 * Authoritative prompt block for a computed breach. Empty unless sla_breached.
 * Tells the model the elapsed time is a SYSTEM FACT, forbids repeating the SLA
 * window as if still upcoming, and steers toward an honest acknowledgement /
 * escalation instead of a fresh ETA promise.
 */
function buildSlaBreachBlock(model) {
  if (!model || model.sla_breached !== true) return '';
  const windows = Array.isArray(model.breached_policies) && model.breached_policies.length
    ? model.breached_policies.map((t) => `«${t}»`).join('، ')
    : '';
  return `\n\n⏰ تنبيه وقت (حقيقة نظامية — لا تخترع وقتاً غيرها): طلب هذا العميل مُسجّل منذ ${model.elapsed_human} فعلياً، وهذه المدة تجاوزت مهلة الـSLA المعلنة${windows ? ` (${windows})` : ''} التي انقضت بالكامل.
- ممنوع أن تكرر المهلة الأصلية وكأنها ما زالت قادمة (مثل «يأخذ حتى ${model.expected_sla_human}») — المهلة انقضت.
- كن صادقاً: اعترف بأن الطلب تأخّر عن المدة المعلنة، بجملة قصيرة، بدون وعد بوقت جديد غير مؤكد.
- إن كانت جهة التصعيد مُعدّة، وجّه الطلب للفريق المختص للمتابعة الفورية.`;
}

module.exports = { parseSlaDurationMs, computeSlaBreach, buildSlaBreachBlock };
