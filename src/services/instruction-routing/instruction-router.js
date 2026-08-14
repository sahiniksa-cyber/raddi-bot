'use strict';

/**
 * Instruction Routing Layer — router (PURE, no I/O).
 *
 * Given a classified instruction segment and the tenant config, decide WHERE it
 * belongs (the structured sink) instead of dumping operational text into the
 * free-text prompt. The load-bearing case is ESCALATION: an escalation to a
 * target that cannot be resolved to a real destination must NOT be stored
 * silently (the old bug where the bot promised a transfer nobody received) — it
 * asks the merchant to finish setting up the target.
 */

// ل-prefixed words that are NOT an escalation target ("if", "but", "we have"...).
const L_STOPWORDS = new Set([
  'لو', 'لكن', 'لا', 'لم', 'لن', 'لماذا', 'لدينا', 'لديك', 'له', 'لها', 'لهم', 'لك', 'لي', 'لنا',
]);
const PREPOSITIONS = new Set(['إلى', 'الى', 'الي']);

function normalizeArabic(s) {
  return String(s == null ? '' : s)
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function contactHasDestination(contact) {
  if (!contact || typeof contact !== 'object') return false;
  return Boolean(
    String(contact.target || '').trim()
    || String(contact.jid || '').trim()
    || String(contact.groupJid || '').trim()
    || String(contact.phone || '').trim(),
  );
}

function cleanTarget(token) {
  return String(token || '').replace(/[،.؟!:]+$/u, '').trim();
}

// Extract the escalation target name. Two Arabic forms: an explicit preposition
// ("إلى سعود" → next token) or the attached ل-prefix ("لسعود" → "سعود", "للفريق"
// → "فريق"). ل-stopwords ("لو", "لكن"...) and ال-words are skipped. A missing
// target is the signal to ask the merchant who to escalate to (clarify).
function extractTargetName(line) {
  const tokens = String(line || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (PREPOSITIONS.has(tokens[i]) && tokens[i + 1]) {
      const name = cleanTarget(tokens[i + 1]);
      if (name) return name;
    }
  }
  for (const t of tokens) {
    if (t.length >= 3 && t[0] === 'ل' && !t.startsWith('لا') && !L_STOPWORDS.has(t)) {
      let name = t.slice(1);
      if (name.startsWith('ل')) name = name.slice(1); // "للفريق" → "فريق"
      name = cleanTarget(name);
      if (name) return name;
    }
  }
  return null;
}

function extractCondition(line) {
  const m = String(line || '').match(/(?:إذا|اذا|لو|عند|في\s*حال|متى|حينما)\s+(.+?)(?:\s+(?:حوّل|حول|صعّد|صعد|بلّغ|بلغ|كلّم|كلم|رجّع|راجع)|$)/);
  return m ? m[1].trim() : '';
}

// A contact's stable id. Prefer an explicit id; otherwise derive a deterministic
// one from the normalized name so a rule references the same contact across edits.
function contactStableId(contact) {
  if (contact && String(contact.id || '').trim()) return String(contact.id).trim();
  return `name:${normalizeArabic(contact && contact.name)}`;
}

// EXACT normalized name/alias match only — never a fuzzy `includes` that could
// pick the wrong contact. Returns ALL exact matches so the caller can treat more
// than one as ambiguous (→ clarification) rather than guessing.
function findContactsByExactName(config, targetName) {
  const contacts = Array.isArray(config && config.escalationContacts) ? config.escalationContacts : [];
  const t = normalizeArabic(targetName);
  if (!t) return [];
  return contacts.filter((c) => {
    if (!c) return false;
    if (normalizeArabic(c.name) === t) return true;
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    return aliases.some((a) => normalizeArabic(a) === t);
  });
}

// Structured trigger (trigger_type + trigger_value) instead of a free-text
// condition. Types: intent | keyword | topic | sla_breach | system_state.
const TRAILING_ESC_VERB = /\s+(?:حوّل\S*|حول\S*|صعّد\S*|صعد\S*|بلّغ\S*|بلغ\S*|كلّم\S*|كلم\S*|رجّع\S*|راجع\S*)$/;

function buildTrigger(line) {
  let m = String(line || '').match(/عن\s+([^\s،.]+(?:\s+[^\s،.]+)?)/);
  if (m) return { trigger_type: 'topic', trigger_value: cleanTarget(m[1].replace(TRAILING_ESC_VERB, '')) };
  m = String(line || '').match(/(?:أسئلة|اسئلة|شكاوى|طلبات|مشاكل|استفسارات)\s+([^\s،.]+)/);
  if (m) return { trigger_type: 'topic', trigger_value: cleanTarget(m[1]) };
  const cond = extractCondition(line);
  if (cond) {
    const kw = cond.split(/\s+/).find((w) => w.length >= 3);
    if (kw) return { trigger_type: 'keyword', trigger_value: cleanTarget(kw) };
  }
  return { trigger_type: 'intent', trigger_value: 'escalation_requested' };
}

function routeEscalation(segment, config) {
  const line = segment.line;
  const trigger = buildTrigger(line);
  const targetName = extractTargetName(line);
  if (!targetName) {
    return { sink: 'escalation', op: 'needs_clarification', reason: 'no_target', trigger };
  }
  const matches = findContactsByExactName(config, targetName).filter(contactHasDestination);
  if (matches.length > 1) {
    return { sink: 'escalation', op: 'needs_clarification', reason: 'ambiguous_target', targetName, trigger };
  }
  if (matches.length === 1) {
    return {
      sink: 'escalationRule',
      op: 'add',
      resolved: true,
      targetContactId: contactStableId(matches[0]),
      targetName,
      trigger,
    };
  }
  // No exact contact with a real destination → do NOT store silently and do NOT
  // let the bot promise a transfer; ask the merchant to finish setting up the target.
  return { sink: 'escalation', op: 'needs_target_setup', resolved: false, targetName, trigger };
}

function extractDuration(line) {
  const m = String(line || '').match(/(\d+)\s*(ساعة|ساعه|ساعات|يوم|أيام|ايام|دقيقة|دقائق|أسبوع|اسبوع)/);
  if (!m) return { amount: null, unit: null };
  return { amount: parseInt(m[1], 10), unit: m[2] };
}

// Below this confidence a classification is not trusted enough to store anything;
// the router asks the merchant to clarify instead of guessing a sink.
const CONFIDENCE_THRESHOLD = Number(process.env.INSTRUCTION_ROUTING_MIN_CONFIDENCE || '0.5');

/**
 * Decide the structured destination for a classified segment. Returns null for a
 * null/empty segment. STYLE is the only thing that stays in botInstructions;
 * UNKNOWN and any low-confidence classification return a clarification request
 * and store NOTHING (never fall through to botInstructions).
 */
function routeInstruction(segment, config = {}) {
  if (!segment || !segment.category) return null;

  if (segment.category === 'UNKNOWN') {
    return { sink: 'review', op: 'needs_clarification', reason: 'unclassified', line: segment.line };
  }
  if (typeof segment.confidence === 'number' && segment.confidence < CONFIDENCE_THRESHOLD) {
    return { sink: 'review', op: 'needs_clarification', reason: 'low_confidence', line: segment.line };
  }

  switch (segment.category) {
    case 'STYLE':
      return { sink: 'botInstructions', op: 'append_persona', line: segment.line };
    case 'KNOWLEDGE':
      return { sink: 'products', op: 'suggest', line: segment.line };
    case 'POLICY':
      return { sink: 'policy', op: 'add', line: segment.line };
    case 'SLA_TIME':
      return { sink: 'slaPolicy', op: 'add', duration: extractDuration(segment.line), line: segment.line };
    case 'PROHIBITION':
      return { sink: 'avoidPhrases', op: 'add', line: segment.line };
    case 'ACTION':
      // No action-execution layer exists yet; flag that it needs a real tool and
      // must never be reported as done from prose alone.
      return { sink: 'actionPolicy', op: 'add', requiresTool: true, line: segment.line };
    case 'ESCALATION':
      return routeEscalation(segment, config);
    default:
      // Never leak an unrecognized category into botInstructions.
      return { sink: 'review', op: 'needs_clarification', reason: 'unrouted_category', line: segment.line };
  }
}

module.exports = {
  routeInstruction,
  routeEscalation,
  normalizeArabic,
  buildTrigger,
  extractTargetName,
  extractCondition,
  extractDuration,
  contactHasDestination,
  contactStableId,
  findContactsByExactName,
  CONFIDENCE_THRESHOLD,
};
